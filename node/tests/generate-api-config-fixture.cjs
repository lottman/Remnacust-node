// Native integration input from the actual node generator, not a Go copy of it.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const load = (file, imports = {}) => {
    const module = { exports: {} };
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'module', 'exports', output)(id => {
        if (!Object.hasOwn(imports, id)) throw Error('Unexpected import: ' + id);
        return imports[id];
    }, module, module.exports);
    return module.exports;
};
const constants = load(path.join(__dirname, '../libs/contract/constants/xray/stats.ts'));
const { generateApiConfig } = load(path.join(__dirname, '../src/common/utils/generate-api-config.ts'), {
    sockdestroy: { hasCapNetAdmin: () => false },
    '@libs/contracts/constants': { XRAY_INTERNAL_FULL_WEBHOOK_PATH: '/fixture' },
    '@libs/contracts/constants/xray': constants,
});
const configuration = route => ({
    log: { loglevel: 'none' },
    routing: { script: route + '.lua' },
    inbounds: [{ tag: 'PORT-A', listen: '127.0.0.1', port: 48101, protocol: 'vless', settings: {
        decryption: 'none', clients: [{ id: 'a4ac647a-075c-4b91-96e9-9fd341fba009', email: 'runtime-user' }],
    } }],
    outbounds: [ ['first', 48201], ['second', 48202] ].map(([tag, port]) => ({
        tag, protocol: 'freedom', settings: { redirect: '127.0.0.1:' + port, finalRules: [{ action: 'allow', ip: ['127.0.0.1/32'] }] },
    })),
});
const prepare = route => generateApiConfig({
    config: configuration(route),
    torrentBlockerState: { enabled: false, includeRuleTags: new Set(), rulePosition: 0 },
    internal: { socketPath: '/private/hook', token: 'fixture', xtlsApiSocketPath: '/fixture/api.sock' },
});
if (!process.argv[2]) throw Error('Specify the native fixture path');
fs.writeFileSync(process.argv[2], JSON.stringify({ version: 1, initial: prepare('first'), updated: prepare('second'), scripts: {
    'first.lua': 'function HandleRoute(ctx) return "first" end',
    'second.lua': 'function HandleRoute(ctx) return "second" end',
} }));
