import { test } from 'node:test';
import assert from 'node:assert/strict';

import { haYamlBlocks } from '../src/modules/home-assistant.js';

test('yaml points at the tablet the user typed', () => {
    const y = haYamlBlocks('192.168.1.50', '8080');
    assert.match(y.rest, /resource: "http:\/\/192\.168\.1\.50:8080\/api\/v1\/machine\/state"/);
    assert.match(y.command, /url: "http:\/\/192\.168\.1\.50:8080\/api\/v1\/machine\/state\/idle"/);
    assert.match(y.command, /url: "http:\/\/192\.168\.1\.50:8080\/api\/v1\/machine\/state\/sleeping"/);
});

test('an empty host leaves an obvious placeholder, never a broken url', () => {
    const y = haYamlBlocks('', '8080');
    assert.match(y.rest, /http:\/\/DE1_TABLET_IP:8080\//);
    assert.doesNotMatch(y.rest, /http:\/\/:/);
});

test('templates read the MachineSnapshot shape from rest_v1.yml', () => {
    const y = haYamlBlocks('de1tablet.home');
    assert.match(y.rest, /value_json\.state\.state/);        // state is nested
    assert.match(y.rest, /value_json\.groupTemperature/);    // temps are top level
    assert.match(y.rest, /value_json\.steamTemperature/);
});

test('the switch reports on for every awake state, not just idle', () => {
    const { template } = haYamlBlocks('de1tablet.home');
    const stateLine = template.split('\n').find((l) => l.trim().startsWith('state:'));
    assert.match(stateLine, /not in \['sleeping'/);
});
