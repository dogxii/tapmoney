import { node, portrait, iconButton, icon } from './ui.js';

export function initAdmin({ onSaved }) {
  const dialog = document.querySelector('#admin-dialog');
  dialog.setAttribute('aria-label', '管理');
  const entry = document.querySelector('#manage-open');
  let token = '', config, tab = 'games';
  try { token = sessionStorage.getItem('tapmoney-admin') ?? ''; } catch { /* 可仅使用内存登录 */ }
  const remember = () => { try { if (token) sessionStorage.setItem('tapmoney-admin', token); else sessionStorage.removeItem('tapmoney-admin'); } catch { /* 存储不可用 */ } };
  const syncEntry = () => { entry.replaceChildren(icon(config ? 'edit' : 'plus')); entry.title = config ? '管理游戏与作者' : '管理'; entry.setAttribute('aria-label', entry.title); };
  async function api(route, options = {}) {
    const response = await fetch(route, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) { token = ''; config = null; remember(); syncEntry(); }
      throw new Error(data.error ?? '暂时无法连接管理服务。');
    }
    return data;
  }
  function header(title, authenticated = false) {
    const head = node('div', 'dialog-header'); head.append(node('h2', '', title));
    const actions = node('div', 'dialog-actions');
    if (authenticated) {
      const logout = iconButton('logout', '退出管理');
      logout.addEventListener('click', () => { token = ''; config = null; remember(); syncEntry(); showLogin(); }); actions.append(logout);
    }
    const close = iconButton('close', '关闭管理'); close.addEventListener('click', () => dialog.close()); actions.append(close); head.append(actions);
    return head;
  }
  function message(text = '', error = false) {
    const status = node('p', `admin-message${error ? ' error' : ''}`, text); status.setAttribute('role', 'status'); status.hidden = !text;
    return status;
  }
  function setMessage(element, text, error = false) { element.textContent = text; element.hidden = !text; element.classList.toggle('error', error); }
  function field(label, value = '', { type = 'text', required = false, placeholder = '' } = {}) {
    const wrapper = node('label', 'form-field'); wrapper.append(node('span', '', label));
    const input = node('input'); input.type = type; input.value = value; input.required = required; input.placeholder = placeholder;
    wrapper.append(input); return { wrapper, input };
  }
  function showLogin(error = '') {
    dialog.replaceChildren(header('管理'));
    const form = node('form', 'login-form');
    const credential = field('管理 Token', '', { type: 'password', required: true }); credential.input.autocomplete = 'off'; credential.input.spellcheck = false;
    const status = message(error, Boolean(error));
    const submit = node('button', 'primary-button', '登录'); submit.type = 'submit';
    form.append(credential.wrapper, status, submit); dialog.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); token = credential.input.value.trim(); credential.input.value = ''; submit.disabled = true; setMessage(status, '正在验证');
      try { config = await api('/api/admin/config'); remember(); syncEntry(); showPanel(); }
      catch (error) { token = ''; config = null; remember(); setMessage(status, error.message, true); }
      finally { submit.disabled = false; }
    });
  }
  function showPanel(feedback = '') {
    if (!config) { showLogin(); return; }
    dialog.replaceChildren(header('管理', true));
    const toolbar = node('div', 'admin-toolbar');
    const tabs = node('div', 'tabs');
    for (const [key, title] of [['games', '游戏'], ['authors', '作者']]) {
      const button = node('button', key === tab ? 'active' : '', title); button.type = 'button'; button.setAttribute('aria-pressed', String(key === tab));
      button.addEventListener('click', () => { tab = key; showPanel(); }); tabs.append(button);
    }
    const add = node('button', 'secondary-button'); add.type = 'button'; add.append(icon('plus'), document.createTextNode(tab === 'games' ? '添加游戏' : '添加作者'));
    add.addEventListener('click', () => tab === 'games' ? editGame() : editAuthor()); toolbar.append(tabs, add);
    const list = node('div', 'admin-list');
    for (const item of config[tab]) {
      const row = node('div', 'admin-row');
      row.append(portrait(tab === 'games' ? item.iconUrl : item.avatarUrl, item.name, tab === 'games' ? 'game-logo' : 'avatar'));
      const text = node('div', 'admin-row-text'); text.append(node('strong', '', item.name));
      text.append(node('span', '', tab === 'games' ? item.appId : `${item.gameIds.length} 款游戏`)); row.append(text);
      const edit = iconButton('edit', `编辑${item.name}`); edit.addEventListener('click', () => tab === 'games' ? editGame(item) : editAuthor(item));
      const remove = iconButton('trash', `删除${item.name}`);
      remove.addEventListener('click', async () => {
        if (!window.confirm(`删除「${item.name}」？`)) return;
        remove.disabled = true;
        const next = structuredClone(config);
        if (tab === 'games') { next.games = next.games.filter(game => game.appId !== item.appId); next.authors.forEach(author => { author.gameIds = author.gameIds.filter(id => id !== item.appId); }); }
        else next.authors = next.authors.filter(author => author.id !== item.id);
        try { await save(next); showPanel('已删除'); }
        catch (error) { if (!config) showLogin(error.message); else showPanel(error.message); }
      });
      const actions = node('div', 'dialog-actions'); actions.append(edit, remove); row.append(actions); list.append(row);
    }
    if (!config[tab].length) list.append(node('div', 'empty', tab === 'games' ? '暂无游戏' : '暂无作者'));
    dialog.append(toolbar, list, message(feedback));
  }
  async function save(next) {
    config = await api('/api/admin/config', { method: 'PUT', body: JSON.stringify(next) });
    syncEntry(); await onSaved();
  }
  function editor(title) {
    dialog.replaceChildren(header(title, true));
    const form = node('form', 'editor-form'); const fields = node('div', 'form-fields'); const status = message();
    const actions = node('div', 'form-actions');
    const cancel = node('button', 'secondary-button', '取消'); cancel.type = 'button'; cancel.addEventListener('click', () => showPanel());
    const submit = node('button', 'primary-button', '保存'); submit.type = 'submit';
    actions.append(cancel, submit); form.append(fields, status, actions); dialog.append(form);
    return { form, fields, status, submit };
  }
  function gameId(value) {
    const input = value.trim();
    if (/^\d{1,16}$/.test(input)) return input;
    try { const url = new URL(input); if (['www.taptap.cn', 'taptap.cn'].includes(url.hostname)) return url.pathname.match(/^\/app\/(\d{1,16})\/?$/)?.[1] ?? ''; } catch { /* 手动填写 ID */ }
    return '';
  }
  function editGame(game) {
    const view = editor(game ? '编辑游戏' : '添加游戏');
    const id = field('游戏 ID / TapTap 链接', game?.appId ?? '', { required: true }); id.input.disabled = Boolean(game);
    const name = field('名称', game?.name ?? '', { required: true }); name.input.maxLength = 128;
    const logo = field('Logo 链接', game?.iconUrl ?? '', { type: 'url', placeholder: '自动获取，可留空' });
    const start = field('累计起始日期', game?.totalStartDate ?? '2020-01-01', { type: 'date', required: true });
    const lookup = iconButton('refresh', '获取游戏资料'); id.wrapper.classList.add('lookup-field'); id.wrapper.append(lookup);
    let lookingUp = false;
    async function lookupGame() {
      const appId = gameId(id.input.value); if (!appId || lookingUp) return;
      lookingUp = true; lookup.disabled = true;
      try { const data = await api(`/api/admin/game?id=${appId}`); if (!name.input.value) name.input.value = data.name ?? ''; if (!logo.input.value) logo.input.value = data.iconUrl ?? ''; setMessage(view.status, ''); }
      catch (error) { if (!config) showLogin(error.message); else setMessage(view.status, error.message, true); }
      finally { lookup.disabled = false; lookingUp = false; }
    }
    lookup.addEventListener('click', lookupGame); if (!game) id.input.addEventListener('blur', lookupGame);
    view.fields.append(id.wrapper, name.wrapper, logo.wrapper, start.wrapper);
    const group = node('fieldset', 'bindings'); group.append(node('legend', '', '作者'));
    const select = node('select'); select.setAttribute('aria-label', '游戏作者'); select.append(node('option', '', '自动识别')); select.firstElementChild.value = '';
    for (const author of config.authors) { const option = node('option', '', author.name); option.value = author.id; select.append(option); }
    const bound = config.authors.filter(author => author.gameIds.includes(game?.appId));
    if (bound.length === 1) select.value = bound[0].id;
    const multi = bound.length > 1;
    if (multi) {
      const keep = node('option', '', '保留当前多作者绑定'); keep.value = '__keep'; select.append(keep); select.value = '__keep';
    }
    group.append(select); view.fields.append(group);
    view.form.addEventListener('submit', async event => {
      event.preventDefault();
      const appId = gameId(id.input.value);
      if (!appId) { setMessage(view.status, '请输入有效的游戏 ID 或 TapTap 链接。', true); return; }
      if (!game && config.games.some(item => item.appId === appId)) { setMessage(view.status, '该游戏已经添加。', true); return; }
      view.submit.disabled = true;
      const next = structuredClone(config);
      const updated = { ...(game ?? {}), appId, name: name.input.value.trim(), iconUrl: logo.input.value.trim(), totalStartDate: start.input.value };
      if (game) next.games = next.games.map(item => item.appId === game.appId ? updated : item); else next.games.push(updated);
      if (select.value !== '__keep') next.authors.forEach(author => { author.gameIds = author.gameIds.filter(value => value !== appId); if (author.id === select.value) author.gameIds.push(appId); });
      try { await save(next); showPanel(game ? '已保存' : '已添加，下次每日采集后更新收益'); }
      catch (error) { if (!config) showLogin(error.message); else setMessage(view.status, error.message, true); }
      finally { view.submit.disabled = false; }
    });
  }
  function editAuthor(author) {
    const view = editor(author ? '编辑作者' : '添加作者');
    const name = field('昵称', author?.name ?? '', { required: true }); name.input.maxLength = 64;
    const qq = field('QQ 号', author?.qq ?? '', { placeholder: '选填' }); qq.input.inputMode = 'numeric';
    const avatar = field('头像链接', author?.avatarUrl ?? '', { type: 'url', placeholder: 'QQ 或其他 HTTPS 头像链接' });
    const tap = field('TapTap 主页', author?.tapUrl ?? '', { type: 'url', placeholder: '选填' });
    view.fields.append(name.wrapper, qq.wrapper, avatar.wrapper, tap.wrapper);
    const bindings = node('fieldset', 'bindings'); bindings.append(node('legend', '', '绑定游戏'));
    const checkboxes = [];
    for (const game of config.games) {
      const label = node('label', 'binding-option'); const input = node('input'); input.type = 'checkbox'; input.value = game.appId; input.checked = author?.gameIds.includes(game.appId) ?? false;
      label.append(input, node('span', '', game.name)); bindings.append(label); checkboxes.push(input);
    }
    if (!config.games.length) bindings.append(node('span', 'value-missing', '请先添加游戏'));
    view.fields.append(bindings);
    view.form.addEventListener('submit', async event => {
      event.preventDefault(); view.submit.disabled = true;
      const next = structuredClone(config);
      const updated = { id: author?.id ?? `author-${crypto.randomUUID()}`, name: name.input.value.trim(), qq: qq.input.value.trim(), avatarUrl: avatar.input.value.trim(), tapUrl: tap.input.value.trim(), gameIds: checkboxes.filter(input => input.checked).map(input => input.value) };
      if (author) next.authors = next.authors.map(item => item.id === author.id ? updated : item); else next.authors.push(updated);
      try { await save(next); showPanel('已保存'); }
      catch (error) { if (!config) showLogin(error.message); else setMessage(view.status, error.message, true); }
      finally { view.submit.disabled = false; }
    });
  }
  entry.addEventListener('click', async () => {
    if (!dialog.open) dialog.showModal();
    if (!token) { showLogin(); return; }
    dialog.replaceChildren(header('管理'), message('正在加载'));
    try { config = await api('/api/admin/config'); syncEntry(); showPanel(); }
    catch (error) { showLogin(error.message); }
  });
  dialog.addEventListener('close', () => { if (!config) dialog.replaceChildren(); });
  syncEntry();
  if (token) api('/api/admin/config').then(data => { config = data; syncEntry(); }).catch(() => { token = ''; remember(); });
}
