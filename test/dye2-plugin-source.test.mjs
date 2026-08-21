import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Decaid owns plugin distribution (doc/Plugins.md): it records where each plugin
// came from and installs new releases itself, holding back only updates that ask
// for permissions the installed version does not hold. Streamline reads that
// state and never talks to GitHub. What is checked here:
//   - the install/approve wrappers hit the right endpoints and shape errors so a
//     409 ("the candidate moved since you reviewed it") is distinguishable from
//     an ordinary failure -- the settings card branches on that;
//   - getDye2VersionInfo maps the bridge fields the card renders, and reports an
//     unreachable bridge instead of passing it off as "not installed";
//   - the switch-on update offer prompts only when a decision is actually needed.
//
// api.js / dyeStrip.js can't be imported under node (browser globals), so the
// functions under test are lifted out of the source and run with their
// dependencies injected -- same trick as settings-sync.test.mjs.

function lift(module, patterns) {
    const source = readFileSync(new URL(`../src/modules/${module}`, import.meta.url), 'utf8');
    return patterns.map(pattern => {
        const match = source.match(pattern);
        assert.ok(match, `${module}: no match for ${pattern}`);
        return match[0].replace('export ', '');
    }).join('\n');
}

// ── Install / update-check / approve wrappers (api.js) ───────────────────────
{
    const body = lift('api.js', [
        /export async function installPluginFromRelease\([\s\S]*?\r?\n\}/,
        /export async function checkPluginUpdates\(\) \{[\s\S]*?\r?\n\}/,
        /export async function approvePluginUpdate\(pluginId\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = (responder) => {
        const calls = [];
        const api = new Function(
            'API_BASE_URL', 'fetch',
            `${body}\nreturn { installPluginFromRelease, checkPluginUpdates, approvePluginUpdate };`
        )('http://x:8080/api/v1', async (url, opts) => {
            calls.push({ url, opts });
            return responder(url, opts);
        });
        return { api, calls };
    };

    const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
    const fail = (status, payload) => ({ ok: false, status, statusText: 'Conflict', json: async () => payload });

    test('installPluginFromRelease posts the repo to the github-release endpoint', async () => {
        const { api, calls } = build(() => ok({ id: 'dye2.reaplugin', version: '0.1.6' }));
        const result = await api.installPluginFromRelease('decentespresso/dye2');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'http://x:8080/api/v1/plugins/install/github-release');
        assert.equal(calls[0].opts.method, 'POST');
        assert.deepEqual(JSON.parse(calls[0].opts.body), { repo: 'decentespresso/dye2' });
        assert.equal(result.version, '0.1.6');
    });

    test('checkPluginUpdates posts to the update endpoint', async () => {
        const { api, calls } = build(() => ok({ message: 'Plugin update check complete' }));
        await api.checkPluginUpdates();

        assert.equal(calls[0].url, 'http://x:8080/api/v1/plugins/update');
        assert.equal(calls[0].opts.method, 'POST');
    });

    test('approvePluginUpdate surfaces a 409 as a status the caller can branch on', async () => {
        const { api, calls } = build(() => fail(409, { error: 'Update of dye2.reaplugin changed since it was approved' }));

        await assert.rejects(
            () => api.approvePluginUpdate('dye2.reaplugin'),
            (e) => {
                // 409 means Decaid recorded a *new* pending update; retrying the same
                // call only 409s again, so the card must re-read and show the new delta.
                assert.equal(e.status, 409);
                assert.match(e.message, /changed since it was approved/);
                return true;
            }
        );
        assert.equal(calls[0].url, 'http://x:8080/api/v1/plugins/dye2.reaplugin/update/approve');
    });

    test('a failed install reports the server error, not just the status code', async () => {
        const { api } = build(() => fail(500, { error: 'Plugin package has 2 plugin roots; expected exactly one' }));
        await assert.rejects(
            () => api.installPluginFromRelease('decentespresso/dye2'),
            /2 plugin roots/
        );
    });
}

// ── Bridge state for the settings card (dyeStrip.js) ─────────────────────────
{
    const body = lift('dyeStrip.js', [
        /export async function getDye2VersionInfo\(\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = (getPlugins) => new Function(
        'PLUGIN_ID', 'getPlugins',
        `${body}\nreturn getDye2VersionInfo;`
    )('dye2.reaplugin', getPlugins);

    test('getDye2VersionInfo maps installed version, source and pending update', async () => {
        const getDye2VersionInfo = build(async () => [
            { id: 'settings.reaplugin', version: '1.0.0', loaded: true },
            {
                id: 'dye2.reaplugin',
                version: '0.1.6',
                loaded: true,
                source: { kind: 'github_release', repo: 'decentespresso/dye2', releaseTag: 'v0.1.6' },
                pendingUpdate: { version: '0.2.0', releaseTag: 'v0.2.0', addedPermissions: ['proxy.decent_api'] },
            },
        ]);

        const info = await getDye2VersionInfo();
        assert.equal(info.reachable, true);
        assert.equal(info.installed, '0.1.6');
        assert.equal(info.loaded, true);
        assert.equal(info.source.releaseTag, 'v0.1.6');
        assert.deepEqual(info.pending.addedPermissions, ['proxy.decent_api']);
    });

    test('an installed plugin with no pending update reports none', async () => {
        const getDye2VersionInfo = build(async () => [{ id: 'dye2.reaplugin', version: '0.1.6', loaded: false }]);
        const info = await getDye2VersionInfo();

        assert.equal(info.reachable, true);
        assert.equal(info.loaded, false);
        assert.equal(info.pending, null);
        assert.equal(info.source, null);
    });

    test('a plugin absent from the list reads as not installed, not as unreachable', async () => {
        const getDye2VersionInfo = build(async () => []);
        const info = await getDye2VersionInfo();

        assert.equal(info.reachable, true);
        assert.equal(info.installed, null);
    });

    test('an unreachable bridge is reported as such, never as "not installed"', async () => {
        // getPlugins returns null on a failed fetch, and can also reject outright.
        for (const getPlugins of [async () => null, async () => { throw new Error('offline'); }]) {
            const info = await build(getPlugins)();
            assert.equal(info.reachable, false);
            assert.equal(info.installed, null);
        }
    });
}

// ── Automatic update check + the switch-on offer (dyeStrip.js) ───────────────
{
    const body = lift('dyeStrip.js', [
        /export async function checkDye2UpdatesIfDue\(\) \{[\s\S]*?\r?\n\}/,
        /export async function offerDye2Update\(\) \{[\s\S]*?\r?\n\}/,
    ]);

    // The bridge is a single mutable state, as it is in the app: checkPluginUpdates
    // is what changes it, because Decaid installs permissionless updates inside
    // that call and records a pendingUpdate for the rest.
    const build = ({ state, onCheck, promptResult = false }) => {
        const calls = { checks: 0, prompts: [] };
        let current = state;
        const fns = new Function(
            'getDye2VersionInfo', 'checkPluginUpdates', 'promptPluginUpdate', 'logger', 'CHECK_COOLDOWN_MS',
            `${body}\nreturn { checkDye2UpdatesIfDue, offerDye2Update };`
        )(
            async () => current,
            async () => {
                calls.checks++;
                const next = onCheck?.();
                if (next instanceof Error) throw next;
                if (next) current = next;
            },
            async (info) => { calls.prompts.push(info); return promptResult; },
            { info() {}, error() {} },
            15 * 60 * 1000,
        );
        return { ...fns, calls };
    };

    const installed = (version, { checkedMinutesAgo = 120, ...extra } = {}) => ({
        reachable: true, installed: version, loaded: true,
        source: {
            kind: 'github_release', repo: 'decentespresso/dye2', releaseTag: `v${version}`,
            lastChecked: new Date(Date.now() - checkedMinutesAgo * 60 * 1000).toISOString(),
        },
        pending: null, ...extra,
    });

    test('an untracked copy is left alone -- Decaid cannot update a ZIP or folder install', async () => {
        const { checkDye2UpdatesIfDue, calls } = build({ state: { ...installed('0.1.6'), source: null } });
        await checkDye2UpdatesIfDue();
        assert.equal(calls.checks, 0);
    });

    test('a check Decaid ran minutes ago is not repeated -- GitHub allows 60 an hour', async () => {
        const { checkDye2UpdatesIfDue, calls } = build({ state: installed('0.1.6', { checkedMinutesAgo: 2 }) });
        await checkDye2UpdatesIfDue();
        assert.equal(calls.checks, 0);
    });

    test('a source that has never been checked is checked', async () => {
        const state = installed('0.1.6');
        delete state.source.lastChecked;
        const { checkDye2UpdatesIfDue, calls } = build({ state });
        await checkDye2UpdatesIfDue();
        assert.equal(calls.checks, 1);
    });

    test('the check returns the state after it, so the settings card renders the outcome', async () => {
        const { checkDye2UpdatesIfDue } = build({
            state: installed('0.1.6'),
            onCheck: () => installed('0.2.0'),
        });
        assert.equal((await checkDye2UpdatesIfDue()).installed, '0.2.0');
    });

    test('a failed check leaves the installed plugin reported as-is, never throws', async () => {
        const { checkDye2UpdatesIfDue, calls } = build({
            state: installed('0.1.6'),
            onCheck: () => new Error('403 rate limited'),
        });
        assert.equal((await checkDye2UpdatesIfDue()).installed, '0.1.6');
        assert.equal(calls.checks, 1);
    });

    test('the check never prompts -- only the switch-on path does', async () => {
        const pending = { version: '0.2.0', addedPermissions: ['proxy.decent_api'] };
        const { checkDye2UpdatesIfDue, calls } = build({
            state: installed('0.1.6'),
            onCheck: () => installed('0.1.6', { pending }),
        });
        const info = await checkDye2UpdatesIfDue();
        assert.deepEqual(info.pending, pending);
        assert.equal(calls.prompts.length, 0);
    });

    test('an update needing no new permission is already installed by the check, so no prompt', async () => {
        const { offerDye2Update, calls } = build({
            state: installed('0.1.6'),
            onCheck: () => installed('0.2.0'),
        });
        assert.equal(await offerDye2Update(), true);
        assert.equal(calls.prompts.length, 0);
    });

    test('a permission-escalating update prompts on switch-on, and the prompt decides the result', async () => {
        const pending = { version: '0.2.0', addedPermissions: ['proxy.decent_api'] };
        const { offerDye2Update, calls } = build({
            state: installed('0.1.6'),
            onCheck: () => installed('0.1.6', { pending }),
            promptResult: true,
        });
        assert.equal(await offerDye2Update(), true);
        assert.deepEqual(calls.prompts[0].pending, pending);
    });

    test('a pendingUpdate from an earlier check still prompts while the check is on cooldown', async () => {
        const pending = { version: '0.2.0', addedPermissions: ['emit'] };
        const { offerDye2Update, calls } = build({
            state: installed('0.1.6', { checkedMinutesAgo: 2, pending }),
        });
        await offerDye2Update();
        assert.equal(calls.checks, 0);
        assert.equal(calls.prompts.length, 1);
    });

    test('nothing to do when the plugin is already current', async () => {
        const { offerDye2Update, calls } = build({ state: installed('0.1.6') });
        assert.equal(await offerDye2Update(), false);
        assert.equal(calls.prompts.length, 0);
    });
}
