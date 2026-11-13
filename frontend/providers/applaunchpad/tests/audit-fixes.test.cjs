const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { loadSource, root } = require('./load-source.cjs');

const load = loadSource();
const tools = load('utils/tools');
const convert = load('utils/deployYaml2Json');
const defaults = load('constants/editApp').defaultEditVal;
const clone = (value) => JSON.parse(JSON.stringify(value));
const makeData = () => clone(defaults);
const workload = (data, kind = 'deployment') => yaml.load(convert.json2DeployCr(data, kind));

function workloadPatch(data, next, actual, kind = 'deployment') {
  const oldForm = workload(data, kind);
  const newForm = workload(next, kind);
  newForm.spec.template.metadata.labels.restartTime = oldForm.spec.template.metadata.labels.restartTime;
  return tools.patchYamlList({
    formOldYamlList: [yaml.dump(oldForm)],
    newYamlList: [yaml.dump(newForm)],
    crYamlList: [actual]
  }).find((item) => item.type === 'patch')?.value;
}

// RFC 7396 semantics, matching updateApp's JSON merge patch content type.
function mergePatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  const result = current && typeof current === 'object' ? clone(current) : {};
  for (const [key, value] of Object.entries(clone(patch))) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

test('missing global ConfigMap configuration preserves all YAML documents', () => {
  const data = makeData();
  const input = [convert.json2Service(data), convert.json2DeployCr(data, 'deployment')];
  for (const [name, mount] of [['', ''], ['global-configmap', ''], ['', '/etc/global']]) {
    const output = tools.addConfigMapToYamlList(input, name, mount);
    assert.deepEqual(clone(output), input);
    const actions = tools.patchYamlList({
      formOldYamlList: input, newYamlList: output, crYamlList: input.map((item) => yaml.load(item))
    });
    assert.equal(actions.length, 0);
  }
});

test('configured global ConfigMap is still injected once', () => {
  const source = [convert.json2DeployCr(makeData(), 'deployment')];
  const once = tools.addConfigMapToYamlList(source, 'global-configmap', '/etc/global');
  const twice = tools.addConfigMapToYamlList(once, 'global-configmap', '/etc/global');
  const spec = yaml.load(twice[0]).spec.template.spec;
  assert.equal(spec.volumes.filter((item) => item.name === 'global-configmap').length, 1);
  assert.equal(spec.containers[0].volumeMounts[0].mountPath, '/etc/global');
});

for (const kind of ['deployment', 'statefulset']) {
  test(`${kind}: legacy hostname selector is removed when keeping, changing or clearing a node`, () => {
    const data = makeData(); data.nodeName = 'node-a';
    for (const hasPreference of [false, true]) {
      const actual = workload(data, kind);
      if (!hasPreference) delete actual.spec.template.spec.affinity;
      actual.spec.template.spec.nodeSelector = {
        'kubernetes.io/hostname': 'node-a',
        'kubernetes.io/os': 'linux',
        'accelerator': 'gpu'
      };
      for (const nextNode of ['node-a', 'node-b', '']) {
        const next = clone(data); next.nodeName = nextNode;
        const patch = workloadPatch(data, next, actual, kind);
        assert(patch, 'legacy selector must produce a patch even if the form is unchanged');
        assert.equal(patch.spec.template.spec.nodeSelector['kubernetes.io/hostname'], null);
        const updated = mergePatch(actual, patch);
        const spec = updated.spec.template.spec;
        assert.deepEqual(spec.nodeSelector, { 'kubernetes.io/os': 'linux', accelerator: 'gpu' });
        const preferred = spec.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution;
        if (nextNode) assert.equal(preferred[0].preference.matchExpressions[0].values[0], nextNode);
        else assert.equal(preferred, undefined);
        assert.equal(workloadPatch(next, clone(next), updated, kind), undefined);
      }
    }
  });

  test(`${kind}: legacy nodeName migrates even without other form changes`, () => {
    const data = makeData(); data.nodeName = 'node-a';
    const actual = workload(data, kind);
    delete actual.spec.template.spec.affinity;
    actual.spec.template.spec.nodeName = 'node-a';
    const patch = workloadPatch(data, clone(data), actual, kind);
    assert.equal(patch.spec.template.spec.nodeName, null);
    const spec = mergePatch(actual, patch).spec.template.spec;
    assert.equal(spec.nodeName, undefined);
    assert.equal(spec.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution[0]
      .preference.matchExpressions[0].values[0], 'node-a');
  });

  test(`${kind}: changing or clearing a preferred node takes effect`, () => {
    const data = makeData(); data.nodeName = 'node-a';
    const actual = workload(data, kind);
    for (const nextNode of ['node-b', '']) {
      const next = clone(data); next.nodeName = nextNode;
      const patch = workloadPatch(data, next, actual, kind);
      const preferred = mergePatch(actual, patch).spec.template.spec.affinity.nodeAffinity
        .preferredDuringSchedulingIgnoredDuringExecution;
      if (nextNode) assert.equal(preferred[0].preference.matchExpressions[0].values[0], nextNode);
      else assert.equal(preferred, undefined);
    }
  });
}

test('changing a node preserves unrelated affinity rules', () => {
  const data = makeData(); data.nodeName = 'node-a';
  const actual = workload(data);
  const affinity = actual.spec.template.spec.affinity;
  const zonePreference = { weight: 5, preference: { matchExpressions: [{ key: 'zone', operator: 'In', values: ['east'] }] } };
  affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution.push(zonePreference);
  affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution = {
    nodeSelectorTerms: [{ matchExpressions: [{ key: 'disk', operator: 'In', values: ['ssd'] }] }]
  };
  affinity.podAntiAffinity = { preferredDuringSchedulingIgnoredDuringExecution: [] };
  const next = clone(data); next.nodeName = '';
  const updated = mergePatch(actual, workloadPatch(data, next, actual)).spec.template.spec.affinity;
  assert.deepEqual(updated.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution, [zonePreference]);
  assert.deepEqual(updated.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution,
    affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution);
  assert.deepEqual(updated.podAntiAffinity, affinity.podAntiAffinity);
});

test('unchanged scheduling does not create a redundant patch', () => {
  for (const node of ['', 'node-a']) {
    const data = makeData(); data.nodeName = node;
    assert.equal(workloadPatch(data, clone(data), workload(data)), undefined);
  }
});

test('legacy nodeName can be changed or cleared during migration', () => {
  const data = makeData(); data.nodeName = 'node-a';
  const actual = workload(data);
  delete actual.spec.template.spec.affinity;
  actual.spec.template.spec.nodeName = 'node-a';
  for (const node of ['', 'node-b']) {
    const next = clone(data); next.nodeName = node;
    const spec = mergePatch(actual, workloadPatch(data, next, actual)).spec.template.spec;
    assert.equal(spec.nodeName, undefined);
    const preferred = spec.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution;
    if (node) assert.equal(preferred[0].preference.matchExpressions[0].values[0], node);
    else assert.equal(preferred, undefined);
  }
});

test('command and args always serialize to string arrays', () => {
  for (const [input, expected] of [
    ['10', ['10']], ['0', ['0']], ['true', ['true']], ['null', ['null']],
    ['["-c","echo hello"]', ['-c', 'echo hello']], ['"hello world"', ['hello world']],
    ['[1]', ['[1]']], ['{"key":1}', ['{"key":1}']],
    ['sleep 10 && echo done', ['sleep 10 && echo done']], ['', undefined]
  ]) {
    const data = makeData(); data.containers[0].runCMD = 'sleep'; data.containers[0].cmdParam = input;
    const container = workload(data).spec.template.spec.containers[0];
    assert.deepEqual(container.command, ['sleep']);
    assert.deepEqual(container.args, expected);
  }
  const data = makeData(); data.containers[0].runCMD = '/bin/sh -c';
  assert.deepEqual(workload(data).spec.template.spec.containers[0].command, ['/bin/sh', '-c']);
  data.containers[0].runCMD = '["/bin/sh","-c"]';
  assert.deepEqual(workload(data).spec.template.spec.containers[0].command, ['/bin/sh', '-c']);
});

test('command form fields are registered in source', () => {
  const source = fs.readFileSync(path.join(root, 'src/pages/app/edit/components/Form.tsx'), 'utf8');
  const activeLines = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert(activeLines.includes('{...register(`containers.${containerIndex}.runCMD`)}'));
  assert(activeLines.includes('{...register(`containers.${containerIndex}.cmdParam`)}'));
});

test('HPA targets the actual workload kind', () => {
  const data = makeData(); data.hpa.use = true;
  assert.equal(yaml.load(convert.json2HPA(data)).spec.scaleTargetRef.kind, 'Deployment');
  data.storeList = [{ name: 'data', path: '/data', value: 1 }];
  assert.equal(yaml.load(convert.json2HPA(data)).spec.scaleTargetRef.kind, 'StatefulSet');
});

test('editing an existing StatefulSet repairs its legacy HPA target', () => {
  const data = makeData(); data.hpa.use = true;
  data.storeList = [{ name: 'data', path: '/data', value: 1 }];
  const formYaml = convert.json2HPA(data);
  const actual = yaml.load(formYaml);
  actual.spec.scaleTargetRef.kind = 'Deployment';
  const patches = tools.patchYamlList({
    formOldYamlList: [formYaml], newYamlList: [formYaml], crYamlList: [actual]
  });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].kind, 'HorizontalPodAutoscaler');
  assert.equal(patches[0].value.spec.scaleTargetRef.kind, 'StatefulSet');
});

for (const kind of ['Deployment', 'StatefulSet']) {
  for (const versioned of [false, true]) {
    test(`${kind}: ${versioned ? 'v1alpha' : 'normal'} pause/resume keeps HPA threshold`, async () => {
      const data = makeData(); data.hpa.use = true; data.hpa.value = 50;
      let app = workload(data, kind.toLowerCase());
      let hpa = yaml.load(convert.json2HPA(data, kind));
      const originalThreshold = hpa.spec.metrics[0].resource.target.averageUtilization;
      const client = {
        namespace: 'wrong-default-namespace',
        getDeployApp: async () => clone(app),
        apiClient: { patch: async (value) => {
          assert.equal(value.metadata.resourceVersion, undefined);
          assert.deepEqual(Object.keys(value.spec), ['replicas']);
          app = mergePatch(app, value);
          return { body: clone(app) };
        } },
        k8sAutoscaling: {
          readNamespacedHorizontalPodAutoscaler: async (_, namespace) => {
            assert.equal(namespace, 'selected-ns'); return { body: clone(hpa) };
          },
          deleteNamespacedHorizontalPodAutoscaler: async (_, namespace) => { assert.equal(namespace, 'selected-ns'); }
        },
        applyYamlList: async (values) => {
          assert.equal(app.metadata.annotations[load('constants/app').pauseKey], undefined);
          assert(app.spec.replicas > 0);
          hpa = yaml.load(values[0]);
        }
      };
      const mocked = loadSource({
        '@/services/backend/auth': { getAdminAuthorization: async () => 'mock', authSession: async () => 'mock' },
        '@/services/backend/kubernetes': { getK8s: async () => client },
        '@/services/backend/response': { jsonRes: (_, response) => { if (response?.error) throw response.error; } }
      });
      const req = { headers: {}, query: { namespace: 'selected-ns', appName: data.appName } };
      for (let iteration = 0; iteration < 2; iteration++) {
        if (versioned) {
          const api = mocked('pages/api/v1alpha/updateReplica');
          await api.PauseApp({ appName: data.appName, replica: '0', req });
          await api.StartApp({ appName: data.appName, replica: '1', req });
        } else {
          await mocked('pages/api/pauseApp').default(req, {});
          await mocked('pages/api/startApp').default(req, {});
        }
        assert.equal(hpa.spec.metrics[0].resource.target.averageUtilization, originalThreshold);
        assert.equal(hpa.spec.scaleTargetRef.kind, kind);
      }
    });
  }
}

async function updateStorage(stateFulSetYaml) {
  const calls = { listed: 0, deleted: [], resized: [], configPatched: 0 };
  let response;
  const mocked = loadSource({
    '@/services/backend/auth': { authSession: async () => 'mock' },
    '@/services/backend/kubernetes': { getK8s: async () => ({
      k8sApp: {}, k8sNetworkingApp: {}, k8sAutoscaling: {}, k8sCustomObjects: {},
      k8sCore: {
        listNamespacedPersistentVolumeClaim: async () => {
          calls.listed++;
          return { body: { items: [{
            metadata: { name: 'data-demo-0', annotations: { path: '/data', value: '1' } },
            spec: { resources: { requests: { storage: '1Gi' } } }
          }] } };
        },
        deleteNamespacedPersistentVolumeClaim: async (name) => { calls.deleted.push(name); },
        patchNamespacedPersistentVolumeClaim: async (...args) => { calls.resized.push(args); },
        replaceNamespacedConfigMap: async () => { calls.configPatched++; }
      },
      applyYamlList: async () => []
    }) },
    '@/services/backend/response': { jsonRes: (_, result) => { response = result || {}; } }
  });
  await mocked('pages/api/updateApp').default({
    headers: {}, query: { namespace: 'test' }, body: {
      appName: 'demo', stateFulSetYaml,
      patch: [{ type: 'patch', kind: 'ConfigMap', value: { metadata: { name: 'demo' }, data: { key: 'value' } } }]
    }
  }, {});
  return { calls, response };
}

test('omitted storage YAML never lists or deletes PVCs', async () => {
  for (const input of [undefined, '']) {
    const { calls, response } = await updateStorage(input);
    assert.equal(response.error, undefined);
    assert.equal(calls.listed, 0);
    assert.deepEqual(calls.deleted, []);
    assert.equal(calls.configPatched, 1);
  }
});

test('invalid storage YAML is rejected before any storage mutation', async () => {
  for (const input of ['null', 'kind: Deployment', 'kind: StatefulSet\nmetadata:\n  name: another-app',
    'kind: StatefulSet\nmetadata:\n  name: demo']) {
    const { calls, response } = await updateStorage(input);
    assert(response.error);
    assert.equal(calls.listed, 0);
    assert.deepEqual(calls.deleted, []);
  }
});

test('explicit storage updates still retain, resize and delete matching PVCs', async () => {
  for (const size of [1, 2, null]) {
    const data = makeData(); data.appName = 'demo';
    data.storeList = size === null ? [] : [{ name: 'data', path: '/data', value: size }];
    const { calls, response } = await updateStorage(convert.json2DeployCr(data, 'statefulset'));
    assert.equal(response.error, undefined);
    assert.equal(calls.listed, 1);
    assert.equal(calls.resized.length, size === 2 ? 1 : 0);
    assert.equal(calls.deleted.length, size === null ? 1 : 0);
  }
});
