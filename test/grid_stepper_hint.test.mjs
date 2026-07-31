// Drives the real createGridStepper through the hint sequence in a DOM stub.
// Creation order per stepper: div(wrapper), span(display), button(−), button(+)
import { readFileSync } from 'fs';
import assert from 'assert';

const src  = readFileSync('src/modules/profile_editor.js', 'utf8');
const body = src.slice(src.indexOf('let _activeStepper = null;'),
                       src.indexOf('\n// ─── Render Functions'));

const stub = `
const made = [];
const mk = (tag) => { const e = { tag, style:{}, className:'', textContent:'', _l:{},
  setAttribute(){}, appendChild(){}, addEventListener(ev,fn){ this._l[ev]=fn; } };
  made.push(e); return e; };
const document = { createElement: mk };
const STEPPER_BTN_CLASS='';
const roundTo=(v)=>v, clamp=(v,a,b)=>Math.min(Math.max(v,a),b);
const flashPlusMinusButton=()=>{}, shouldUseNumpad=()=>true;
let numpadOpens=0;
const openNumpadForField=()=>{ numpadOpens++; };
const inlineEditValue=()=>true;
`;

const M = new Function(stub + body + `
  return { createGridStepper, made, opens:()=>numpadOpens,
           state:()=>({hints:_hintSteppers.length, dismissed:_hintsDismissed}) };`)();

const lim = { min:0, max:100, step:1 }, np = { title:'T' };
const groups = [];
function build(opts) { const before = M.made.length; M.createGridStepper(opts);
  const g = M.made.slice(before); groups.push({ display:g[1], minus:g[2], plus:g[3] }); return groups.at(-1); }

const base = { value:50, lim, numpad:np, onChange(){} };
const temps = [0,1,2,3].map(()=>build({ ...base, revealOnTap:true, startRevealed:true }));
const pumps = [0,1,2,3].map(()=>build({ ...base, revealOnTap:true }));

const vis = g => g.minus.style.visibility;
const shown = arr => arr.map(vis).join(',');

// 1. First paint: all Temp ± visible, all Pump ± hidden
assert.strictEqual(shown(temps), 'visible,visible,visible,visible', '1: temps visible on first paint');
assert.strictEqual(shown(pumps), 'hidden,hidden,hidden,hidden',     '1: pumps hidden on first paint');
assert.strictEqual(M.state().hints, 4, '1: four hints armed');

// 2. Tap a PUMP pill -> that pump reveals, every Temp hint retires
pumps[2].display._l.click();
assert.strictEqual(shown(temps), 'hidden,hidden,hidden,hidden', '2: all temp hints retired');
assert.strictEqual(vis(pumps[2]), 'visible',                    '2: tapped pump revealed');
assert.strictEqual(shown(pumps), 'hidden,hidden,visible,hidden','2: only tapped pump revealed');
assert.strictEqual(M.state().dismissed, true, '2: dismissal is sticky');

// 3. Tap a different pump -> previous collapses (single active stepper)
pumps[0].display._l.click();
assert.strictEqual(shown(pumps), 'visible,hidden,hidden,hidden', '3: previous collapsed');

// 4. Re-render within the session must NOT re-arm the hint
const temps2 = [0,1].map(()=>build({ ...base, revealOnTap:true, startRevealed:true }));
assert.strictEqual(shown(temps2), 'hidden,hidden', '4: hint not re-armed after dismissal');

// 5. Tapping an already-revealed pill edits it (opens numpad) rather than re-revealing
const before = M.opens();
pumps[0].display._l.click();
assert.strictEqual(M.opens(), before + 1, '5: second tap opens the numpad');
assert.strictEqual(vis(pumps[0]), 'visible', '5: stays revealed while editing');

console.log('all 5 hint-sequence assertions passed');
