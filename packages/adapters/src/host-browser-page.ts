/** Runs only in Chrome's isolated world; page scripts cannot read refs or saved login values. */
export const HOST_BROWSER_PAGE_HELPERS = String.raw`
(() => {
  if (globalThis.__rakazoHostBrowser) return;
  const refs = new Map();
  const loginFilled = new WeakSet();
  class Refused extends Error {}
  const refused = message => { throw new Refused(message); };
  let nextRef = 0;
  const prefix = Math.random().toString(36).slice(2);
  let keyTargets = [];
  let keyText = '';
  const visible = el => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const file = el => el instanceof HTMLInputElement && el.type === 'file';
  const controls = root => {
    const result = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.matches('a[href],button,input,textarea,select,summary,[role],[contenteditable=true],[tabindex]')) result.push(el);
      if (el.shadowRoot) result.push(...controls(el.shadowRoot));
    }
    return result;
  };
  const resolve = ref => {
    const el = refs.get(ref);
    if (!el || !el.isConnected || !(visible(el) || file(el))) refused('Unknown element ref. Call browser_snapshot and use a fresh ref.');
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') refused('Element is disabled');
    return el;
  };
  const fill = (ref, text, origin, field) => {
    let saved;
    if (origin) {
      try { saved = new URL(origin); } catch { /* Refuse below. */ }
      if (!saved || saved.protocol !== 'https:' || location.protocol !== 'https:' || saved.origin !== location.origin)
        refused('Open the saved HTTPS site with browser_navigate, then fill again.');
    }
    const el = resolve(ref);
    // Check restrictions before focus, whose handlers may replace or retype the input.
    const check = () => {
      if (el.readOnly) refused('Element is read-only');
      if (origin && field !== 'username' && !(el instanceof HTMLInputElement && el.type === 'password'))
        refused('A saved password can only be typed into a password field.');
      if (origin && field === 'username' && !(el instanceof HTMLInputElement && ['text','email','tel'].includes(el.type)))
        refused('A saved username can only be typed into a text, email, or telephone field.');
      if (origin && location.origin !== saved.origin) refused('The page changed. Open the saved site again.');
    };
    check(); el.focus(); check();
    if (!el.isConnected) refused('The field changed. Call browser_snapshot again.');
    if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find(option => option.value === text || option.text === text);
      if (!option) refused('No matching option');
      text = option.value;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el instanceof HTMLInputElement && !['text','search','email','url','tel','password','number'].includes(el.type))
        refused('Input requires a click or browser preview');
      const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype
        : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
      const set = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      set.call(el, text);
      if (el.value !== text) {
        if (origin) set.call(el, '');
        refused('The field did not accept the requested value');
      }
      if (origin) loginFilled.add(el); else loginFilled.delete(el);
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    } else if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event('input', {bubbles:true}));
    } else refused('Element is not fillable');
    return true;
  };
  globalThis.__rakazoHostBrowser = {
    snapshot() {
      refs.clear();
      const elements = [];
      for (const el of controls(document)) {
        if (!(visible(el) || file(el)) || el.type === 'hidden') continue;
        if (elements.length >= 250 && !file(el)) continue;
        const ref = 'e' + prefix + (++nextRef).toString(36);
        refs.set(ref, el);
        const tag = el.tagName.toLowerCase();
        const role = file(el) ? 'file upload' : el.getAttribute('role') ||
          (tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : ['input','textarea'].includes(tag)
            ? ['checkbox','radio'].includes(el.type) ? el.type : 'textbox' : tag);
        const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
          .map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
        const name = (el.getAttribute('aria-label') || labelledBy || [...(el.labels || [])].map(l => l.textContent).join(' ').trim()
          || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || el.textContent || tag).trim().slice(0,200);
        const value = el.type === 'password' || loginFilled.has(el) ? undefined
          : file(el) ? [...(el.files || [])].map(file => file.name).join(', ')
          : ['checkbox','radio'].includes(el.type) ? el.checked ? 'checked' : 'unchecked'
          : 'value' in el ? String(el.value).slice(0,2000) : undefined;
        elements.push({ref,tag,role,name,...(value === undefined ? {} : {value})});
      }
      const tree = (document.body?.innerText || '').slice(0,12000) + '\n' + elements.map(el =>
        '- ' + el.role + ' ' + JSON.stringify(el.name) + ' [' + el.ref + ']' + (el.value === undefined ? '' : ' value=' + JSON.stringify(el.value))).join('\n');
      return {url:location.href,title:document.title.slice(0,200),tree,elements,loading:document.readyState !== 'complete'};
    },
    clickPoint(ref) {
      try {
        const el=resolve(ref);
        if (el.href && !['https:','http:'].includes(new URL(el.href,location.href).protocol)) refused('Unsupported link URL');
        el.scrollIntoView({block:'center',inline:'center'});
        const rect=el.getBoundingClientRect();
        if (!rect.width || !rect.height) refused('Use browser upload to attach files');
        const x=Math.max(0,Math.min(innerWidth-1,rect.left+rect.width/2));
        const y=Math.max(0,Math.min(innerHeight-1,rect.top+rect.height/2));
        const hit=document.elementFromPoint(x,y);
        if (hit !== el && !el.contains(hit) && !el.shadowRoot?.contains(hit)) refused('The element is covered. Use the browser preview.');
        return {ok:true,x,y};
      } catch(error) {return error instanceof Refused ? {ok:false,error:error.message} : {ok:false,error:'The page interrupted this click'};}
    },
    act(action) {
      try {
      if (action.kind === 'fill' || action.kind === 'type') { fill(action.ref,action.text,action.origin,action.field); return {ok:true}; }
      refused('Unsupported page action');
      } catch (error) {
        return error instanceof Refused ? {ok:false,uncertain:false,error:error.message} : {ok:false,uncertain:true,error:'The page interrupted this action'};
      }
    },
    prepareKeys(ref,text) {
      const el = resolve(ref);
      if (el instanceof HTMLSelectElement) return {select:true};
      if (el.readOnly || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) refused('Element is not editable');
      keyTargets = [el]; keyText = text;
      if (el instanceof HTMLInputElement && el.maxLength === 1 && text.length > 1) {
        const inputs = controls(document).filter(input => input instanceof HTMLInputElement && visible(input) && input.maxLength === 1 && input.type === el.type && input.form === el.form);
        const own = el.getBoundingClientRect();
        const nearby = inputs.filter(input => {const r=input.getBoundingClientRect(); return Math.abs(r.top-own.top) < own.height/2 && Math.abs(r.left-own.left) < own.height*20;});
        if (nearby.length > 1 && nearby.length <= 12) keyTargets = nearby;
      }
      for (const target of keyTargets) {
        loginFilled.delete(target);
        if (target.isContentEditable) target.textContent = '';
        else {
          const prototype = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype,'value').set.call(target,'');
        }
        target.dispatchEvent(new Event('input',{bubbles:true}));
      }
      keyTargets[0].focus();
      return {select:false};
    },
    focusHolds() { return keyTargets.some(el => el.isConnected && (el === document.activeElement || el.contains(document.activeElement))); },
    typed() {
      const shown = keyTargets.map(el => el.isContentEditable ? el.textContent : el.value).join('');
      return shown === keyText;
    },
    fileInput(ref,count) {
      const el = resolve(ref);
      if (!file(el)) refused('Upload requires a file input');
      if (count > 1 && !el.multiple) refused('This file upload accepts one file');
      return el;
    },
  };
})()
`;
