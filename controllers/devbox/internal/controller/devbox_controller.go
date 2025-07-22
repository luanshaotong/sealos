/*
Copyright 2024.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"fmt"
	"sync"
	"time"

	devboxv1alpha1 "github.com/labring/sealos/controllers/devbox/api/v1alpha1"
	"github.com/labring/sealos/controllers/devbox/internal/controller/helper"
	"github.com/labring/sealos/controllers/devbox/internal/controller/utils/matcher"
	"github.com/labring/sealos/controllers/devbox/internal/controller/utils/resource"
	"github.com/labring/sealos/controllers/devbox/label"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/util/rand"
	"k8s.io/client-go/tools/record"
	"k8s.io/client-go/util/retry"
	"k8s.io/utils/ptr"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
)

// DevboxReconciler reconciles a Devbox object
type DevboxReconciler struct {
	CommitImageRegistry string

	RequestRate      resource.RequestRate
	EphemeralStorage resource.EphemeralStorage

	PodMatchers []matcher.PodMatcher

	DebugMode bool

	client.Client
	Scheme                   *runtime.Scheme
	Recorder                 record.EventRecorder
	RestartPredicateDuration time.Duration
}

// map lock for devboxName
var devboxLocks = make(map[string]*sync.Mutex)

// +kubebuilder:rbac:groups=devbox.sealos.io,resources=devboxes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=devbox.sealos.io,resources=devboxes/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=devbox.sealos.io,resources=devboxes/finalizers,verbs=update
// +kubebuilder:rbac:groups=devbox.sealos.io,resources=runtimes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=devbox.sealos.io,resources=runtimeclasses,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=*
// +kubebuilder:rbac:groups="",resources=pods/status,verbs=get;update;patch
// +kubebuilder:rbac:groups="",resources=services,verbs=*
// +kubebuilder:rbac:groups="",resources=secrets,verbs=*
// +kubebuilder:rbac:groups="",resources=events,verbs=*

func (r *DevboxReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	devboxFullName := fmt.Sprintf("%s/%s", req.Namespace, req.Name)
	// Lock the devbox to prevent concurrent access
	lock, exists := devboxLocks[devboxFullName]
	if !exists {
		lock = &sync.Mutex{}
		devboxLocks[devboxFullName] = lock
	}
	ok := lock.TryLock()
	if !ok {
		logger.Info("devbox is being processed by another request, skipping", "devbox", devboxFullName)
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}
	defer lock.Unlock()

	devbox := &devboxv1alpha1.Devbox{}
	if err := r.Get(ctx, req.NamespacedName, devbox); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	recLabels := label.RecommendedLabels(&label.Recommended{
		Name:      devbox.Name,
		ManagedBy: label.DefaultManagedBy,
		PartOf:    devboxv1alpha1.DevBoxPartOf,
	})

	if devbox.ObjectMeta.DeletionTimestamp.IsZero() {
		// retry add finalizer
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			latestDevbox := &devboxv1alpha1.Devbox{}
			if err := r.Get(ctx, req.NamespacedName, latestDevbox); err != nil {
				return client.IgnoreNotFound(err)
			}
			if controllerutil.AddFinalizer(latestDevbox, devboxv1alpha1.FinalizerName) {
				return r.Update(ctx, latestDevbox)
			}
			return nil
		})
		if err != nil {
			return ctrl.Result{}, err
		}
	} else if devbox.Status.Phase == devboxv1alpha1.DevboxPhaseStopped {
		logger.Info("devbox deleted, remove all resources")
		if err := r.removeAll(ctx, devbox, recLabels); err != nil {
			return ctrl.Result{}, err
		}

		logger.Info("devbox deleted, remove finalizer")
		if controllerutil.RemoveFinalizer(devbox, devboxv1alpha1.FinalizerName) {
			if err := r.Update(ctx, devbox); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	} else {
		devbox.Spec.Action = devboxv1alpha1.DevboxActionShutdown
		err := r.Update(ctx, devbox)
		if err != nil {
			logger.Error(err, "failed to update devbox action to Shutdown")
			r.Recorder.Eventf(devbox, corev1.EventTypeWarning, "Update devbox action failed", "%v", err)
			return ctrl.Result{}, err
		}
	}

	devbox.Status.Network.Type = devbox.Spec.NetworkSpec.Type

	helper.GenerateDevboxPhase(devbox)

	// create or update secret
	logger.Info("syncing secret")
	if err := r.syncSecret(ctx, devbox, recLabels); err != nil {
		logger.Error(err, "sync secret failed")
		r.Recorder.Eventf(devbox, corev1.EventTypeWarning, "Sync secret failed", "%v", err)
		return ctrl.Result{}, err
	}
	logger.Info("sync secret success")
	r.Recorder.Eventf(devbox, corev1.EventTypeNormal, "Sync secret success", "Sync secret success")

	// create service if network type is NodePort
	if devbox.Spec.NetworkSpec.Type == devboxv1alpha1.NetworkTypeNodePort {
		logger.Info("syncing service")
		if err := r.Get(ctx, req.NamespacedName, devbox); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.syncService(ctx, devbox, recLabels); err != nil {
			logger.Error(err, "sync service failed")
			r.Recorder.Eventf(devbox, corev1.EventTypeWarning, "Sync service failed", "%v", err)
			return ctrl.Result{}, err
		}
		logger.Info("sync service success")
		r.Recorder.Eventf(devbox, corev1.EventTypeNormal, "Sync service success", "Sync service success")
	}

	// create or update pod
	logger.Info("syncing pod")
	newStatus := r.syncPod(ctx, devbox, recLabels)
	if newStatus == devboxv1alpha1.DevboxPhaseError {
		return ctrl.Result{}, fmt.Errorf("sync pod failed, devbox phase is %s", devbox.Status.Phase)
	}
	logger.Info("sync pod success")
	r.Recorder.Eventf(devbox, corev1.EventTypeNormal, "Sync pod success", "Sync pod success")
	if newStatus != devboxv1alpha1.DevboxPhaseNotChanged {
		logger.Info("devbox phase changed", "newPhase", newStatus)
		devbox.Status.Phase = newStatus
		// set state to None because we have processed the action
		devbox.Spec.Action = devboxv1alpha1.DevboxActionNone
	}
	if err := r.Status().Update(ctx, devbox); err != nil {
		logger.Error(err, "update devbox status failed")
		r.Recorder.Eventf(devbox, corev1.EventTypeWarning, "Update devbox status failed", "%v", err)
		return ctrl.Result{}, err
	}

	logger.Info("devbox reconcile success")
	return ctrl.Result{}, nil
}

func (r *DevboxReconciler) syncSecret(ctx context.Context, devbox *devboxv1alpha1.Devbox, recLabels map[string]string) error {
	objectMeta := metav1.ObjectMeta{
		Name:      devbox.Name,
		Namespace: devbox.Namespace,
		Labels:    recLabels,
	}
	devboxSecret := &corev1.Secret{
		ObjectMeta: objectMeta,
	}

	err := r.Get(ctx, client.ObjectKey{Namespace: devbox.Namespace, Name: devbox.Name}, devboxSecret)
	if err == nil {
		// Secret already exists, no need to create

		// TODO: delete this code after we have a way to sync secret to devbox
		// check if SEALOS_DEVBOX_JWT_SECRET is exist, if not exist, create it
		if _, ok := devboxSecret.Data["SEALOS_DEVBOX_JWT_SECRET"]; !ok {
			devboxSecret.Data["SEALOS_DEVBOX_JWT_SECRET"] = []byte(rand.String(32))
			if err := r.Update(ctx, devboxSecret); err != nil {
				return fmt.Errorf("failed to update secret: %w", err)
			}
		}

		if _, ok := devboxSecret.Data["SEALOS_DEVBOX_AUTHORIZED_KEYS"]; !ok {
			devboxSecret.Data["SEALOS_DEVBOX_AUTHORIZED_KEYS"] = devboxSecret.Data["SEALOS_DEVBOX_PUBLIC_KEY"]
			if err := r.Update(ctx, devboxSecret); err != nil {
				return fmt.Errorf("failed to update secret: %w", err)
			}
		}

		return nil
	}
	if client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("failed to get secret: %w", err)
	}

	// Secret not found, create a new one
	publicKey, privateKey, err := helper.GenerateSSHKeyPair()
	if err != nil {
		return fmt.Errorf("failed to generate SSH key pair: %w", err)
	}

	secret := &corev1.Secret{
		ObjectMeta: objectMeta,
		Data: map[string][]byte{
			"SEALOS_DEVBOX_JWT_SECRET":      []byte(rand.String(32)),
			"SEALOS_DEVBOX_PUBLIC_KEY":      publicKey,
			"SEALOS_DEVBOX_PRIVATE_KEY":     privateKey,
			"SEALOS_DEVBOX_AUTHORIZED_KEYS": publicKey,
		},
	}

	if err := controllerutil.SetControllerReference(devbox, secret, r.Scheme); err != nil {
		return fmt.Errorf("failed to set controller reference: %w", err)
	}

	if err := r.Create(ctx, secret); err != nil {
		return fmt.Errorf("failed to create secret: %w", err)
	}
	return nil
}

func (r *DevboxReconciler) syncPod(ctx context.Context, devbox *devboxv1alpha1.Devbox, recLabels map[string]string) devboxv1alpha1.DevboxPhase {
	logger := log.FromContext(ctx)

	var podList corev1.PodList
	if err := r.List(ctx, &podList, client.InNamespace(devbox.Namespace), client.MatchingLabels(recLabels)); err != nil {
		logger.Error(err, "failed to list pods")
		return devboxv1alpha1.DevboxPhaseError
	}
	// only one pod is allowed, if more than one pod found, return error
	if len(podList.Items) > 1 {
		// remove finalizer and delete them
		for _, pod := range podList.Items {
			if controllerutil.RemoveFinalizer(&pod, devboxv1alpha1.FinalizerName) {
				if err := r.Update(ctx, &pod); err != nil {
					logger.Error(err, "remove finalizer failed")
				}
			}
			if err := r.Delete(ctx, &pod); err != nil {
				logger.Error(err, "delete pod failed")
			}
		}
		return devboxv1alpha1.DevboxPhaseError
	}
	logger.Info("pod list", "length", len(podList.Items))

	switch devbox.Status.Phase {
	case devboxv1alpha1.DevboxPhaseRunning:
		nextCommitHistory := r.generateNextCommitHistory(devbox)
		expectPod := r.generateDevboxPod(devbox, nextCommitHistory)

		switch len(podList.Items) {
		case 0:
			logger.Info("create pod")
			logger.Info("next commit history", "commit", nextCommitHistory)
			err := r.createPod(ctx, devbox, expectPod, nextCommitHistory)
			if err != nil && helper.IsExceededQuotaError(err) {
				logger.Info("devbox is exceeded quota, change devbox state to Stopped")
				r.Recorder.Eventf(devbox, corev1.EventTypeWarning, "Devbox is exceeded quota", "Devbox is exceeded quota")
				// devbox.Spec.State = devboxv1alpha1.DevboxStateStopped
				// _ = r.Update(ctx, devbox)
			}
			if err != nil {
				logger.Error(err, "create pod failed")
				return devboxv1alpha1.DevboxPhaseError
			}
			return devboxv1alpha1.DevboxPhaseNotChanged
		case 1:
			pod := &podList.Items[0]
			// check pod container size, if it is 0, it means the pod is not running, return an error
			if len(pod.Status.ContainerStatuses) == 0 {
				logger.Error(fmt.Errorf("pod container size is 0"), "pod container size is 0")
				return devboxv1alpha1.DevboxPhaseError
			}
			devbox.Status.State = pod.Status.ContainerStatuses[0].State
			// update commit predicated status by pod status, this should be done once find a pod
			helper.UpdatePredicatedCommitStatus(devbox, pod)
			// pod has been deleted, handle it, next reconcile will create a new pod, and we will update commit history status by predicated status
			if !pod.DeletionTimestamp.IsZero() {
				logger.Info("pod has been deleted")
				err := r.handlePodDeleted(ctx, devbox, pod)
				if err != nil {
					logger.Error(err, "handle pod deleted failed")
					return devboxv1alpha1.DevboxPhaseError
				}
			}
			switch matcher.PodMatchExpectations(expectPod, pod, r.PodMatchers...) {
			case true:
				// pod match expectations
				logger.Info("pod match expectations")
				switch pod.Status.Phase {
				case corev1.PodPending, corev1.PodRunning:
					// pod is running or pending, do nothing here
					logger.Info("pod is running or pending")
					// update commit history status by pod status
					helper.UpdateCommitHistory(devbox, pod, false)
					return devboxv1alpha1.DevboxPhaseNotChanged
				case corev1.PodFailed, corev1.PodSucceeded:
					// pod failed or succeeded, we need delete pod and remove finalizer
					logger.Info("pod failed or succeeded, recreate pod")
					err := r.deletePod(ctx, devbox, pod)
					if err != nil {
						logger.Error(err, "delete pod failed")
						return devboxv1alpha1.DevboxPhaseError
					}
				}
			case false:
				// pod not match expectations, delete pod anyway
				logger.Info("pod not match expectations, recreate pod")
				err := r.deletePod(ctx, devbox, pod)
				if err != nil {
					logger.Error(err, "delete pod failed")
					return devboxv1alpha1.DevboxPhaseError
				}
			}
		}
		return devboxv1alpha1.DevboxPhaseNotChanged
	case devboxv1alpha1.DevboxPhasePending:
		return devboxv1alpha1.DevboxPhaseNotChanged
	case devboxv1alpha1.DevboxPhaseRestarting, devboxv1alpha1.DevboxPhaseAdvancedStopping, devboxv1alpha1.DevboxPhaseReleasing,
		devboxv1alpha1.DevboxPhaseShutdown, devboxv1alpha1.DevboxPhaseCommitting, devboxv1alpha1.DevboxPhaseShutdownCommitting,
		devboxv1alpha1.DevboxPhaseStopped, devboxv1alpha1.DevboxPhaseAdvancedStopped:
		switch len(podList.Items) {
		case 0:
			switch devbox.Status.Phase {
			case devboxv1alpha1.DevboxPhaseReleasing:
				return devboxv1alpha1.DevboxPhaseCommitting
			case devboxv1alpha1.DevboxPhaseRestarting:
				return devboxv1alpha1.DevboxPhaseRunning
			case devboxv1alpha1.DevboxPhaseAdvancedStopping:
				return devboxv1alpha1.DevboxPhaseAdvancedStopped
			case devboxv1alpha1.DevboxPhaseShutdown:
				return devboxv1alpha1.DevboxPhaseShutdownCommitting
			default:
				return devboxv1alpha1.DevboxPhaseNotChanged
			}
		case 1:
			pod := &podList.Items[0]
			// update state to empty since devbox is stopped
			devbox.Status.State = corev1.ContainerState{}
			// update commit predicated status by pod status, this should be done once find a pod
			helper.UpdatePredicatedCommitStatus(devbox, pod)
			// pod has been deleted, handle it, next reconcile will create a new pod, and we will update commit history status by predicated status
			if !pod.DeletionTimestamp.IsZero() {
				err := r.handlePodDeleted(ctx, devbox, pod)
				if err != nil {
					logger.Error(err, "handle pod deleted failed")
					return devboxv1alpha1.DevboxPhaseError
				}
			} else {
				// we need delete pod because devbox state is stopped
				// we don't care about the pod status, just delete it
				err := r.deletePod(ctx, devbox, pod)
				if err != nil {
					logger.Error(err, "delete pod failed")
					return devboxv1alpha1.DevboxPhaseError
				}
			}
		}
		return devboxv1alpha1.DevboxPhaseNotChanged
	default:
		logger.Error(fmt.Errorf("unknown devbox phase: %s", devbox.Status.Phase), "unknown devbox phase")
	}
	return devboxv1alpha1.DevboxPhaseError
}

func (r *DevboxReconciler) syncService(ctx context.Context, devbox *devboxv1alpha1.Devbox, recLabels map[string]string) error {
	var servicePorts []corev1.ServicePort
	for _, port := range devbox.Spec.Config.Ports {
		servicePorts = append(servicePorts, corev1.ServicePort{
			Name:       port.Name,
			Port:       port.ContainerPort,
			TargetPort: intstr.FromInt32(port.ContainerPort),
			Protocol:   port.Protocol,
		})
	}
	if len(servicePorts) == 0 {
		//use the default value
		servicePorts = []corev1.ServicePort{
			{
				Name:       "devbox-ssh-port",
				Port:       22,
				TargetPort: intstr.FromInt32(22),
				Protocol:   corev1.ProtocolTCP,
			},
		}
	}
	expectServiceSpec := corev1.ServiceSpec{
		Selector: recLabels,
		Type:     corev1.ServiceTypeNodePort,
		Ports:    servicePorts,
	}
	service := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      devbox.Name + "-svc",
			Namespace: devbox.Namespace,
			Labels:    recLabels,
		},
	}
	switch devbox.Status.Phase {
	case devboxv1alpha1.DevboxPhaseRunning, devboxv1alpha1.DevboxPhaseAdvancedStopped:
		if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, service, func() error {
			// only update some specific fields
			service.Spec.Selector = expectServiceSpec.Selector
			service.Spec.Type = expectServiceSpec.Type
			if len(service.Spec.Ports) == 0 {
				service.Spec.Ports = expectServiceSpec.Ports
			} else {
				service.Spec.Ports[0].Name = expectServiceSpec.Ports[0].Name
				service.Spec.Ports[0].Port = expectServiceSpec.Ports[0].Port
				service.Spec.Ports[0].TargetPort = expectServiceSpec.Ports[0].TargetPort
				service.Spec.Ports[0].Protocol = expectServiceSpec.Ports[0].Protocol
			}
			return controllerutil.SetControllerReference(devbox, service, r.Scheme)
		}); err != nil {
			return err
		}
		// Retrieve the updated Service to get the NodePort
		var updatedService corev1.Service
		err := retry.OnError(
			retry.DefaultRetry,
			func(err error) bool { return client.IgnoreNotFound(err) == nil },
			func() error {
				return r.Client.Get(ctx, client.ObjectKey{Namespace: service.Namespace, Name: service.Name}, &updatedService)
			})
		if err != nil {
			return fmt.Errorf("failed to get updated service: %w", err)
		}

		// Extract the NodePort
		nodePort := int32(0)
		for _, port := range updatedService.Spec.Ports {
			if port.NodePort != 0 {
				nodePort = port.NodePort
				break
			}
		}
		if nodePort == 0 {
			return fmt.Errorf("NodePort not found for service %s", service.Name)
		}
		devbox.Status.Network.Type = devboxv1alpha1.NetworkTypeNodePort
		devbox.Status.Network.NodePort = nodePort
		return r.Status().Update(ctx, devbox)
	default:
		err := r.Client.Delete(ctx, service)
		if err != nil && !errors.IsNotFound(err) {
			return err
		}
		devbox.Status.Network = devboxv1alpha1.NetworkStatus{
			Type:     devboxv1alpha1.NetworkTypeNodePort,
			NodePort: int32(0),
		}
		return r.Status().Update(ctx, devbox)
	}
}

// create a new pod, add predicated status to nextCommitHistory
func (r *DevboxReconciler) createPod(ctx context.Context, devbox *devboxv1alpha1.Devbox, expectPod *corev1.Pod, nextCommitHistory *devboxv1alpha1.CommitHistory) error {
	logger := log.FromContext(ctx)

	logger.Info("creating pod",
		"podName", expectPod.Name,
		"namespace", expectPod.Namespace,
		"nextCommitHistory", nextCommitHistory)

	nextCommitHistory.Status = devboxv1alpha1.CommitStatusPending
	nextCommitHistory.PredicatedStatus = devboxv1alpha1.CommitStatusPending

	if expectPod.Name == "" {
		return fmt.Errorf("pod name cannot be empty")
	}

	if err := r.Create(ctx, expectPod); err != nil {
		logger.Error(err, "failed to create pod")
		return err
	}

	devbox.Status.CommitHistory = append(devbox.Status.CommitHistory, nextCommitHistory)
	return nil
}

func (r *DevboxReconciler) deletePod(ctx context.Context, devbox *devboxv1alpha1.Devbox, pod *corev1.Pod) error {
	logger := log.FromContext(ctx)
	// remove finalizer and delete pod
	controllerutil.RemoveFinalizer(pod, devboxv1alpha1.FinalizerName)
	if err := r.Update(ctx, pod); err != nil {
		logger.Error(err, "remove finalizer failed")
		return err
	}
	if err := r.Delete(ctx, pod, client.GracePeriodSeconds(0), client.PropagationPolicy(metav1.DeletePropagationBackground)); err != nil {
		logger.Error(err, "delete pod failed")
		return err
	}
	// update commit history status because pod has been deleted
	if len(pod.Status.ContainerStatuses) != 0 {
		devbox.Status.LastTerminationState = pod.Status.ContainerStatuses[0].State
	}
	helper.UpdateCommitHistory(devbox, pod, true)
	return nil
}

func (r *DevboxReconciler) handlePodDeleted(ctx context.Context, devbox *devboxv1alpha1.Devbox, pod *corev1.Pod) error {
	logger := log.FromContext(ctx)
	devbox.Status.CurrentNode = pod.Spec.NodeName
	controllerutil.RemoveFinalizer(pod, devboxv1alpha1.FinalizerName)
	if err := r.Update(ctx, pod); err != nil {
		logger.Error(err, "remove finalizer failed")
		return err
	}
	// update commit history status because pod has been deleted
	if len(pod.Status.ContainerStatuses) != 0 {
		devbox.Status.LastTerminationState = pod.Status.ContainerStatuses[0].State
	}
	helper.UpdateCommitHistory(devbox, pod, true)
	return nil
}

func (r *DevboxReconciler) removeAll(ctx context.Context, devbox *devboxv1alpha1.Devbox, recLabels map[string]string) error {
	// Delete Pod
	podList := &corev1.PodList{}
	if err := r.List(ctx, podList, client.InNamespace(devbox.Namespace), client.MatchingLabels(recLabels)); err != nil {
		return err
	}
	for _, pod := range podList.Items {
		if controllerutil.RemoveFinalizer(&pod, devboxv1alpha1.FinalizerName) {
			if err := r.Update(ctx, &pod); err != nil {
				return err
			}
		}
	}
	if err := r.deleteResourcesByLabels(ctx, &corev1.Pod{}, devbox.Namespace, recLabels); err != nil {
		return err
	}
	// Delete Service
	if err := r.deleteResourcesByLabels(ctx, &corev1.Service{}, devbox.Namespace, recLabels); err != nil {
		return err
	}
	// Delete Secret
	return r.deleteResourcesByLabels(ctx, &corev1.Secret{}, devbox.Namespace, recLabels)
}

func (r *DevboxReconciler) deleteResourcesByLabels(ctx context.Context, obj client.Object, namespace string, labels map[string]string) error {
	err := r.DeleteAllOf(ctx, obj,
		client.InNamespace(namespace),
		client.MatchingLabels(labels),
	)
	return client.IgnoreNotFound(err)
}

func (r *DevboxReconciler) generateDevboxPod(devbox *devboxv1alpha1.Devbox, nextCommitHistory *devboxv1alpha1.CommitHistory) *corev1.Pod {
	objectMeta := metav1.ObjectMeta{
		Name:        nextCommitHistory.Pod,
		Namespace:   devbox.Namespace,
		Labels:      helper.GeneratePodLabels(devbox),
		Annotations: helper.GeneratePodAnnotations(devbox),
	}

	ports := devbox.Spec.Config.Ports
	// TODO: add extra ports to pod, currently not support
	// ports = append(ports, devbox.Spec.NetworkSpec.ExtraPorts...)

	envs := devbox.Spec.Config.Env
	envs = append(envs, helper.GenerateDevboxEnvVars(devbox, nextCommitHistory)...)

	//get image name
	var imageName string
	if r.DebugMode {
		imageName = devbox.Spec.Image
	} else {
		imageName = helper.GetLastSuccessCommitImageName(devbox)
	}

	volumes := devbox.Spec.Config.Volumes
	volumes = append(volumes, helper.GenerateSSHVolume(devbox))

	volumeMounts := devbox.Spec.Config.VolumeMounts
	volumeMounts = append(volumeMounts, helper.GenerateSSHVolumeMounts()...)

	containers := []corev1.Container{
		{
			Name:         devbox.ObjectMeta.Name,
			Image:        imageName,
			Env:          envs,
			Ports:        ports,
			VolumeMounts: volumeMounts,

			WorkingDir: helper.GetWorkingDir(devbox),
			Command:    helper.GetCommand(devbox),
			Args:       helper.GetArgs(devbox),
			Resources:  helper.GenerateResourceRequirements(devbox, r.RequestRate, r.EphemeralStorage)},
	}

	terminationGracePeriodSeconds := 300
	automountServiceAccountToken := false

	runtimeClassName := devbox.Spec.RuntimeClassName
	var runtimeClassNamePtr *string
	if runtimeClassName == "" {
		runtimeClassNamePtr = nil
	} else {
		runtimeClassNamePtr = ptr.To(runtimeClassName)
	}

	expectPod := &corev1.Pod{
		ObjectMeta: objectMeta,
		Spec: corev1.PodSpec{
			TerminationGracePeriodSeconds: ptr.To(int64(terminationGracePeriodSeconds)),
			AutomountServiceAccountToken:  ptr.To(automountServiceAccountToken),
			RestartPolicy:                 corev1.RestartPolicyNever,

			Hostname:   devbox.Name,
			Containers: containers,
			Volumes:    volumes,

			RuntimeClassName: runtimeClassNamePtr,

			NodeSelector: devbox.Spec.NodeSelector,
			Tolerations:  devbox.Spec.Tolerations,
			Affinity:     devbox.Spec.Affinity,
		},
	}
	// set controller reference and finalizer
	_ = controllerutil.SetControllerReference(devbox, expectPod, r.Scheme)
	controllerutil.AddFinalizer(expectPod, devboxv1alpha1.FinalizerName)
	return expectPod
}

func (r *DevboxReconciler) generateNextCommitHistory(devbox *devboxv1alpha1.Devbox) *devboxv1alpha1.CommitHistory {
	now := time.Now()
	return &devboxv1alpha1.CommitHistory{
		Image:            r.generateImageName(devbox),
		Time:             metav1.Time{Time: now},
		Pod:              devbox.Name + "-" + rand.String(5),
		Status:           devboxv1alpha1.CommitStatusPending,
		PredicatedStatus: devboxv1alpha1.CommitStatusPending,
	}
}

func (r *DevboxReconciler) generateImageName(devbox *devboxv1alpha1.Devbox) string {
	now := time.Now()
	return fmt.Sprintf("%s/%s/%s:%s-%s", r.CommitImageRegistry, devbox.Namespace, devbox.Name, rand.String(5), now.Format("2006-01-02-150405"))
}

type ControllerRestartPredicate struct {
	predicate.Funcs
	duration  time.Duration
	checkTime time.Time
}

func NewControllerRestartPredicate(duration time.Duration) *ControllerRestartPredicate {
	return &ControllerRestartPredicate{
		checkTime: time.Now().Add(-duration),
		duration:  duration,
	}
}

// skip create event p.duration ago
func (p *ControllerRestartPredicate) Create(e event.CreateEvent) bool {
	return e.Object.GetCreationTimestamp().Time.After(p.checkTime)
}

// SetupWithManager sets up the controller with the Manager.
func (r *DevboxReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		WithOptions(controller.Options{MaxConcurrentReconciles: 10}).
		For(&devboxv1alpha1.Devbox{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Owns(&corev1.Pod{}, builder.WithPredicates(predicate.ResourceVersionChangedPredicate{})). // enqueue request if pod spec/status is updated
		Owns(&corev1.Service{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Owns(&corev1.Secret{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		WithEventFilter(NewControllerRestartPredicate(r.RestartPredicateDuration)).
		Complete(r)
}
