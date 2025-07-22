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
	"time"

	devboxv1alpha1 "github.com/labring/sealos/controllers/devbox/api/v1alpha1"
	"github.com/labring/sealos/controllers/devbox/internal/controller/utils/matcher"
	"github.com/labring/sealos/controllers/devbox/internal/controller/utils/resource"
	"github.com/labring/sealos/controllers/devbox/label"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/rand"
	"k8s.io/client-go/tools/record"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
)

// DevboxDaemonReconciler reconciles a Devbox object
type DevboxDaemonReconciler struct {
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

func (r *DevboxDaemonReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	devbox := &devboxv1alpha1.Devbox{}
	if err := r.Get(ctx, req.NamespacedName, devbox); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	recLabels := label.RecommendedLabels(&label.Recommended{
		Name:      devbox.Name,
		ManagedBy: label.DefaultManagedBy,
		PartOf:    devboxv1alpha1.DevBoxPartOf,
	})

	// create or update pod
	logger.Info("syncing pod")
	r.commitPod(ctx, devbox, recLabels)
	logger.Info("devbox reconcile success")
	return ctrl.Result{}, nil
}

func (r *DevboxDaemonReconciler) commitPod(ctx context.Context, devbox *devboxv1alpha1.Devbox, recLabels map[string]string) error {
	logger := log.FromContext(ctx)

	var podList corev1.PodList
	if err := r.List(ctx, &podList, client.InNamespace(devbox.Namespace), client.MatchingLabels(recLabels)); err != nil {
		logger.Error(err, "failed to list pods")
		return err
	}
	// only one pod is allowed, if more than one pod found, return error
	if len(podList.Items) > 1 {
		return fmt.Errorf("found more than one pod for devbox %s/%s, please delete the extra pods", devbox.Namespace, devbox.Name)
	}
	logger.Info("pod list", "length", len(podList.Items))

	switch devbox.Status.Phase {
	case devboxv1alpha1.DevboxPhaseCommitting, devboxv1alpha1.DevboxPhaseShutdownCommitting:
		devbox.Spec.Image = r.generateImageName(devbox)
		// mock commit pod
		if devbox.Status.Phase == devboxv1alpha1.DevboxPhaseCommitting {
			devbox.Status.Phase = devboxv1alpha1.DevboxPhaseStopped
		} else {
			devbox.Status.Phase = devboxv1alpha1.DevboxPhasePending
		}
		devbox.Status.CurrentNode = ""
		r.Update(ctx, devbox)
		r.Status().Update(ctx, devbox)
		// remove container
	default:
		logger.Info("not committing")
	}
	return nil
}

func (r *DevboxDaemonReconciler) generateNextCommitHistory(devbox *devboxv1alpha1.Devbox) *devboxv1alpha1.CommitHistory {
	now := time.Now()
	return &devboxv1alpha1.CommitHistory{
		Image:            r.generateImageName(devbox),
		Time:             metav1.Time{Time: now},
		Pod:              devbox.Name + "-" + rand.String(5),
		Status:           devboxv1alpha1.CommitStatusPending,
		PredicatedStatus: devboxv1alpha1.CommitStatusPending,
	}
}

func (r *DevboxDaemonReconciler) generateImageName(devbox *devboxv1alpha1.Devbox) string {
	now := time.Now()
	return fmt.Sprintf("%s/%s/%s:%s-%s", r.CommitImageRegistry, devbox.Namespace, devbox.Name, rand.String(5), now.Format("2006-01-02-150405"))
}

// SetupWithManager sets up the controller with the Manager.
func (r *DevboxDaemonReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		WithOptions(controller.Options{MaxConcurrentReconciles: 10}).
		For(&devboxv1alpha1.Devbox{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Owns(&corev1.Pod{}, builder.WithPredicates(predicate.ResourceVersionChangedPredicate{})). // enqueue request if pod spec/status is updated
		Owns(&corev1.Service{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Owns(&corev1.Secret{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		WithEventFilter(NewControllerRestartPredicate(r.RestartPredicateDuration)).
		Complete(r)
}
