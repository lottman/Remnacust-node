const assert = require('node:assert/strict');
const test = require('node:test');
require('reflect-metadata');
const { createZodDto, ZodValidationPipe } = require('nestjs-zod');
const { z } = require('zod');

test('the node adapter validates union branches and strips unexpected private fields without merge patches', () => {
    const lock = require('../package-lock.json');
    assert.equal(lock.packages['node_modules/deepmerge'], undefined);
    class PolicyDto extends createZodDto(
        z.object({
            action: z.discriminatedUnion('type', [
                z.object({ type: z.literal('allow'), host: z.string().min(1) }),
                z.object({ type: z.literal('deny'), reason: z.string().min(1) }),
            ]),
        }),
    ) {}
    const pipe = new ZodValidationPipe();
    const metadata = { type: 'body', metatype: PolicyDto };
    for (const action of [null, { type: 'missing' }, { type: 'allow', reason: 'wrong' }]) {
        assert.throws(
            () => pipe.transform({ action }, metadata),
            (error) => error.getStatus() === 400,
        );
    }
    const payload = JSON.parse(
        '{"action":{"type":"allow","host":"example.test","extra":"strip"},"__proto__":{"poisoned":true},"constructor":{"prototype":{"poisoned":true}}}',
    );
    assert.deepEqual(pipe.transform(payload, metadata), {
        action: { type: 'allow', host: 'example.test' },
    });
    assert.equal(Object.prototype.poisoned, undefined);
    assert.deepEqual(pipe.transform({ action: { type: 'deny', reason: 'blocked' } }, metadata), {
        action: { type: 'deny', reason: 'blocked' },
    });
});
