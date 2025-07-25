import { AppStatusEnum, PodStatusEnum } from '@/constants/app';
import { YamlKindEnum } from '@/utils/adapt';
import type {
  V1Deployment,
  V1ConfigMap,
  V1Service,
  V1Ingress,
  V1Secret,
  V1HorizontalPodAutoscaler,
  V1Pod,
  SinglePodMetrics,
  V1StatefulSet
} from '@kubernetes/client-node';
import { MonitorDataResult } from './monitor';

export type HpaTarget = 'cpu' | 'memory' | 'network';

export type DeployKindsType =
  | V1Deployment
  | V1StatefulSet
  | V1ConfigMap
  | V1Service
  | V1Ingress
  | V1Secret
  | V1HorizontalPodAutoscaler;

export type EditType = 'form' | 'yaml';

export type GpuType = {
  manufacturers: string;
  type: string;
  amount: number;
};

export interface AppStatusMapType {
  label: string;
  value: `${AppStatusEnum}`;
  color: string;
  backgroundColor: string;
  dotColor: string;
}

export interface AppListItemType {
  id: string;
  name: string;
  modelVersion: string;
  modelName: string;
  preInspection: string;
  status: AppStatusMapType;
  isPause: boolean;
  isStop: boolean;
  createTime: string;
  cpu: number;
  memory: number;
  gpu?: GpuType;
  usedCpu: MonitorDataResult;
  usedMemory: MonitorDataResult; // average value
  activeReplicas: number;
  minReplicas: number;
  maxReplicas: number;
  storeAmount: number;
  priority: string;
}

export interface AppEditType {
  appName: string;
  nodeName: string;
  modelName: string;
  modelVersion: string;
  preInspection: string;
  priority: string;
  replicas: number | '';
  gpu?: GpuType;
  hpa: {
    use: boolean;
    target: HpaTarget;
    value: number;
    minReplicas: number;
    maxReplicas: number;
  };
  configMapList: {
    mountPath: string;
    value: string;
  }[];
  storeList: {
    name: string;
    path: string;
    value: number;
  }[];
  containers: AppEditContainerType[];
  currentContainerName: string;
}
export interface AppEditContainerType {
  name: string;
  imageName: string;
  imageRepo: string;
  imageTag: string;
  runCMD: string;
  cmdParam: string;
  cpu: number;
  memory: number;
  secret: {
    use: boolean;
    username: string;
    password: string;
    serverAddress: string;
  };
  networks: {
    networkName: string;
    portName: string;
    port: number;
    nodePort?: number;
    protocol: 'HTTP' | 'GRPC' | 'WS';
    openPublicDomain: boolean;
    publicDomain: string; // default domain
    customDomain: string; // custom domain
  }[];
  envs: {
    key: string;
    value: string;
    valueFrom?: any;
  }[];
}

export interface AppDetailType extends AppEditType {
  id: string;
  createTime: string;
  status: AppStatusMapType;
  isPause: boolean;
  imageName: string;
  usedCpu: MonitorDataResult;
  usedMemory: MonitorDataResult;
  crYamlList: DeployKindsType[];
  isStop: boolean;

  // pods: PodDetailType[];
}

export interface PodStatusMapType {
  label: string;
  value: `${PodStatusEnum}`;
  color: string;
  reason?: string;
  message?: string;
  lastStateReason?: string;
}
export interface PodDetailType extends V1Pod {
  podName: string;
  status: PodStatusMapType;
  nodeName: string;
  ip: string;
  restarts: number;
  age: string;
  usedCpu: MonitorDataResult;
  usedMemory: MonitorDataResult;
  cpu: number;
  memory: number;
  podReason?: string;
  podMessage?: string;
}
export interface PodMetrics {
  podName: string;
  cpu: number;
  memory: number;
}

export interface PodEvent {
  id: string;
  reason: string;
  message: string;
  count: number;
  type: string | 'Normal' | 'Warning';
  firstTime: string;
  lastTime: string;
}

export type AppPatchPropsType = (
  | { type: 'delete'; kind: `${YamlKindEnum}`; name: string }
  | { type: 'patch'; kind: `${YamlKindEnum}`; value: Record<string, any> }
  | { type: 'create'; kind: `${YamlKindEnum}`; value: string }
)[];

declare module 'uuid'
