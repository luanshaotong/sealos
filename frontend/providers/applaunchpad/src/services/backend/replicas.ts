import { KubernetesObjectApi, PatchUtils, V1Deployment, V1StatefulSet } from '@kubernetes/client-node';
import { pauseKey } from '@/constants/app';

export const patchAppScale = (
  client: KubernetesObjectApi,
  app: V1Deployment | V1StatefulSet,
  replicas: number,
  pauseState: string | null
) => client.patch(
  {
    apiVersion: app.apiVersion,
    kind: app.kind,
    metadata: {
      name: app.metadata?.name,
      namespace: app.metadata?.namespace,
      // Merge-patch null deletes the annotation; the client types model full resources only.
      annotations: { [pauseKey]: pauseState } as Record<string, string>
    },
    spec: { replicas }
  },
  undefined,
  undefined,
  undefined,
  undefined,
  { headers: { 'Content-Type': PatchUtils.PATCH_FORMAT_JSON_MERGE_PATCH } }
);
