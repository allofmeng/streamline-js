// Drives the real promptVersionRestore in a DOM stub: rows select, Confirm
// appears only after a selection, and titles are never injected as markup.
import { readFileSync } from 'fs';
import assert from 'assert';

const src  = readFileSync('src/modules/profile_editor.js', 'utf8').replace(/\r\n?/g, '\n');
const i    = src.indexOf('// Version picker. Returns the chosen ProfileRecord');
const body = src.slice(i, src.indexOf('\n}\n\nasync function openVersionHistory()', i) + 2);

const stub = `
let appended = null;
function El(tag){ this.tag=tag; this.style={}; this.className=''; this.textContent='';
  this.dataset={}; this.children=[]; this._l={}; this._attrs={};
  const self=this;
  this.classList={ remove:(c)=>{ self.className=self.className.split(/\\s+/).filter(x=>x!==c).join(' '); },
                   add:(c)=>{ self.className=(self.className+' '+c).trim(); },
                   contains:(c)=>self.className.split(/\\s+/).includes(c) }; }
El.prototype.appendChild=function(c){ this.children.push(c); return c; };
El.prototype.remove=function(){}; El.prototype.close=function(){}; El.prototype.showModal=function(){};
El.prototype.setAttribute=function(k,v){ this._attrs[k]=v; };
El.prototype.addEventListener=function(ev,fn){ this._l[ev]=fn; };
El.prototype.descendants=function(o){ o=o||[]; for(const c of this.children){ o.push(c); c.descendants(o);} return o; };
El.prototype.querySelector=function(s){ return this._f(s)[0]||null; };
El.prototype.querySelectorAll=function(s){ return this._f(s); };
El.prototype._f=function(sel){
  const act=sel.match(/^\\[data-act="(.+)"\\]$/);
  return this.descendants().filter(e=> sel==='[data-rows]' ? e.dataset.rows!==undefined
                                     : act ? e.dataset.act===act[1] : false); };
Object.defineProperty(El.prototype,'innerHTML',{
  get(){ return this._html||''; },
  set(v){ this._html=v; this.children.length=0;
    const rows=new El('div'); rows.dataset.rows='';
    const cancel=new El('button'); cancel.dataset.act='cancel';
    const ok=new El('button'); ok.dataset.act='ok'; ok.className='hidden px-[18px] py-[10px]';
    this.appendChild(rows); this.appendChild(cancel); this.appendChild(ok); } });
const document={ createElement:(t)=>new El(t), body:{ appendChild(el){ appended=el; } } };
const getTranslation=(k)=>k;
`;

const make = () => new Function(stub + body +
  '\nreturn { promptVersionRestore, dlg:()=>appended };')();

const XSS = '<img src=x onerror=alert(1)>';
const versions = [
  { id:'a', createdAt:'2026-07-01T10:00:00Z', profile:{ title:'Older' } },
  { id:'b', createdAt:'2026-07-20T10:00:00Z', profile:{ title:XSS } },
];
const parts = (M) => {
  const d = M.dlg();
  return { rows: d.querySelector('[data-rows]').children,
           ok: d.querySelector('[data-act="ok"]'),
           cancel: d.querySelector('[data-act="cancel"]'), dlg: d };
};

// 1. Confirm hidden on open; one row per version
let M = make(); let p = M.promptVersionRestore(versions); let P = parts(M);
assert.strictEqual(P.rows.length, 2, '1: a row per version');
assert.ok(P.ok.classList.contains('hidden'), '1: Confirm hidden before any selection');

// 2. Selecting a row reveals Confirm and marks only that row
P.rows[1]._l.click();
assert.ok(!P.ok.classList.contains('hidden'), '2: Confirm shown after selection');
assert.strictEqual(P.rows[1]._attrs['aria-pressed'], 'true',  '2: picked row pressed');
assert.strictEqual(P.rows[0]._attrs['aria-pressed'], 'false', '2: other row not pressed');
assert.ok(P.rows[1].className.includes('border-[var(--mimoja-blue)]'), '2: picked row highlighted');

// 3. Selecting a row does NOT resolve — only Confirm does
let settled = false; p.then(() => { settled = true; });
await new Promise(r => setImmediate(r));
assert.strictEqual(settled, false, '3: selection alone must not restore');

// 4. Confirm resolves with the selected version
P.ok._l.click();
assert.strictEqual((await p).id, 'b', '4: Confirm returns the picked version');

// 5. Cancel with a selection made still resolves null
M = make(); p = M.promptVersionRestore(versions); P = parts(M);
P.rows[0]._l.click();
P.cancel._l.click();
assert.strictEqual(await p, null, '5: Cancel discards the selection');

// 6. Esc resolves null
M = make(); p = M.promptVersionRestore(versions); P = parts(M);
P.dlg._l.cancel({ preventDefault(){} });
assert.strictEqual(await p, null, '6: Esc cancels');

// 7. A malicious title goes in as text, never as markup
M = make(); M.promptVersionRestore(versions); P = parts(M);
assert.strictEqual(P.rows[1].children[0].textContent, XSS, '7: title set as textContent');
assert.ok(!(P.dlg.innerHTML || '').includes('<img'), '7: title never interpolated into innerHTML');

console.log('all 7 version-dialog assertions passed');
