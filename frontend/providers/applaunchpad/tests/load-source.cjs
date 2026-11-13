const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const requireApp = createRequire(path.join(root, 'package.json'));
const ts = requireApp('typescript');

// Execute the real TS modules with only UI dependencies and external services mocked.
function loadSource(overrides = {}) {
  const cache = new Map();
  function load(file) {
    if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = (id) => {
      if (id in overrides) return overrides[id];
      if (id === '@/store/static') return { SEALOS_DOMAIN: 'example.test', INGRESS_SECRET: 'test' };
      if (id === '@/hooks/useToast' || id === 'next-i18next') return {};
      if (id === 'nanoid') return { customAlphabet: () => () => 'testport' };
      if (id === 'sealos-desktop-sdk') return { infoLog() {}, warnLog() {}, errLog() {} };
      if (id === 'sealos-desktop-sdk/service') return {};
      if (id.startsWith('@/')) return load(path.join(root, 'src', id.slice(2)));
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
      return requireApp(id);
    };
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true
      }
    }).outputText;
    vm.runInNewContext(`(function(require, module, exports) {${compiled}\n})`, {
      console: { log() {}, warn() {}, error() {} },
      process, Buffer, URL, setTimeout,
      window: {
        btoa: (value) => Buffer.from(value).toString('base64'),
        atob: (value) => Buffer.from(value, 'base64').toString()
      }
    }, { filename: file })(localRequire, module, module.exports);
    return module.exports;
  }
  return (file) => load(path.join(root, 'src', file));
}

module.exports = { loadSource, root };
