import { node, portrait, iconButton, icon } from './ui.js';
import { boardPath } from '/shared/boards.mjs';

export function initAdmin({ onSaved, getBoardId }) {
  const dialog = document.querySelector('#admin-dialog');
  dialog.setAttribute('aria-label', '管理');
  const entry = document.querySelector('#manage-open');
  let token = '', config, boardId, tab = 'games';
  const currentBoard = (value = config) => value.boards.find(board => board.id === boardId) ?? value.boards.find(board => board.slug === '');
  const selectCurrentBoard = () => { boardId = getBoardId() ?? config.boards.find(board => board.slug === '').id; };
  let collection, collectionError = '', collecting = false, checking = false, collectionTimer;
  const activeCollection = () => ['requested', 'queued', 'in_progress', 'waiting', 'pending'].includes(collection?.status);
  const coolingDown = () => Date.parse(collection?.nextAllowedAt) > Date.now();
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
    clearTimeout(collectionTimer); collection = null; collectionError = '';
    dialog.replaceChildren(header('管理'));
    const form = node('form', 'login-form');
    const credential = field('管理 Token', '', { type: 'password', required: true }); credential.input.autocomplete = 'off'; credential.input.spellcheck = false;
    const status = message(error, Boolean(error));
    const submit = node('button', 'primary-button', '登录'); submit.type = 'submit';
    form.append(credential.wrapper, status, submit); dialog.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); token = credential.input.value.trim(); credential.input.value = ''; submit.disabled = true; setMessage(status, '正在验证');
      try { config = await api('/api/admin/config'); remember(); syncEntry(); selectCurrentBoard(); showPanel(); checkCollection(); }
      catch (error) { token = ''; config = null; remember(); setMessage(status, error.message, true); }
      finally { submit.disabled = false; }
    });
  }
  function showPanel(feedback = '') {
    if (!config) { showLogin(); return; }
    const board = currentBoard();
    dialog.replaceChildren(header(tab === 'boards' ? '管理榜单' : `管理 · ${board.name}`, true));
    if (tab !== 'boards') {
      const scope = node('div', 'admin-scope'); const select = node('select'); select.setAttribute('aria-label', '管理的榜单');
      for (const item of config.boards) { const option = node('option', '', `${item.name} · ${boardPath(item)}`); option.value = item.id; select.append(option); }
      select.value = board.id; select.addEventListener('change', () => { boardId = select.value; showPanel(); }); scope.append(select); dialog.append(scope);
    }
    const toolbar = node('div', 'admin-toolbar');
    const tabs = node('div', 'tabs');
    for (const [key, title] of [['games', '游戏'], ['authors', '作者'], ['boards', '榜单']]) {
      const button = node('button', key === tab ? 'active' : '', title); button.type = 'button'; button.setAttribute('aria-pressed', String(key === tab));
      button.addEventListener('click', () => { tab = key; showPanel(); }); tabs.append(button);
    }
    const add = node('button', 'secondary-button'); add.type = 'button'; add.append(icon('plus'), document.createTextNode(tab === 'games' ? '添加游戏' : tab === 'authors' ? '添加作者' : '新建榜单'));
    add.addEventListener('click', () => tab === 'games' ? editGame() : tab === 'authors' ? editAuthor() : editBoard());
    const collect = iconButton('refresh', '采集全部榜单'); collect.id = 'admin-collect';
    collect.addEventListener('click', async () => {
      collecting = true; collectionError = ''; updateCollection();
      try { collection = await api('/api/admin/collect', { method: 'POST' }); }
      catch (error) { collectionError = error.message; if (!config) { showLogin(error.message); return; } }
      finally { collecting = false; }
      updateCollection(); scheduleCollectionCheck();
    });
    const tools = node('div', 'dialog-actions'); tools.append(collect, add); toolbar.append(tabs, tools);
    const list = node('div', 'admin-list');
    const items = tab === 'boards' ? config.boards : board[tab];
    for (const item of items) {
      const row = node('div', 'admin-row');
      const avatarUrl = item.avatarUrl || (item.qq ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(item.qq)}&s=100` : null);
      if (tab !== 'boards') row.append(portrait(tab === 'games' ? item.iconUrl : avatarUrl, item.name, tab === 'games' ? 'game-logo' : 'avatar'));
      const text = node('div', 'admin-row-text'); text.append(node('strong', '', item.name));
      text.append(node('span', '', tab === 'games' ? item.appId : tab === 'authors' ? `${item.gameIds.length} 款游戏` : `${boardPath(item)} · ${item.games.length} 款游戏`)); row.append(text);
      const edit = iconButton('edit', `编辑${item.name}`); edit.addEventListener('click', () => tab === 'games' ? editGame(item) : tab === 'authors' ? editAuthor(item) : editBoard(item));
      const remove = iconButton('trash', `删除${item.name}`);
      remove.addEventListener('click', async () => {
        if (!window.confirm(tab === 'boards' ? `删除「${item.name}」及该榜的游戏和作者配置？` : `从「${board.name}」删除「${item.name}」？`)) return;
        remove.disabled = true;
        const next = structuredClone(config);
        const target = currentBoard(next);
        if (tab === 'games') { target.games = target.games.filter(game => game.appId !== item.appId); target.authors.forEach(author => { author.gameIds = author.gameIds.filter(id => id !== item.appId); }); }
        else if (tab === 'authors') target.authors = target.authors.filter(author => author.id !== item.id);
        else next.boards = next.boards.filter(board => board.id !== item.id);
        try { await save(next, tab === 'boards' && item.id === getBoardId() ? '/' : undefined); showPanel('已删除'); }
        catch (error) { if (!config) showLogin(error.message); else showPanel(error.message); }
      });
      const actions = node('div', 'dialog-actions'); actions.append(edit); if (tab !== 'boards' || item.slug !== '') actions.append(remove); row.append(actions); list.append(row);
    }
    if (!items.length) list.append(node('div', 'empty', tab === 'games' ? '暂无游戏' : '暂无作者'));
    const collectionStatus = node('div', 'admin-collection'); collectionStatus.id = 'admin-collection-status'; collectionStatus.setAttribute('role', 'status');
    dialog.append(toolbar, list, collectionStatus, message(feedback));
    updateCollection(); scheduleCollectionCheck();
  }
  function updateCollection() {
    const button = dialog.querySelector('#admin-collect');
    const status = dialog.querySelector('#admin-collection-status');
    if (!button || !status) return;
    const busy = collecting || activeCollection();
    button.disabled = !collection?.enabled || busy || coolingDown();
    button.classList.toggle('collecting', busy);
    button.title = collection?.enabled === false ? '手动采集尚未配置' : busy ? '采集进行中' : coolingDown() ? '请稍后再采集' : '采集全部榜单';
    status.replaceChildren();
    const labels = { requested: '等待采集', queued: '采集排队中', in_progress: '采集中', waiting: '等待采集', pending: '等待采集' };
    let text = collectionError || (collecting ? '正在提交' : labels[collection?.status] ?? '');
    if (!text && collection?.status === 'completed') text = collection.conclusion === 'success' ? '采集完成' : collection.conclusion === 'cancelled' ? '采集已取消' : '采集失败';
    if (!text && collection?.enabled === false) text = '手动采集尚未配置';
    status.hidden = !text;
    status.classList.toggle('error', Boolean(collectionError) || collection?.status === 'completed' && collection.conclusion !== 'success');
    status.append(node('span', '', text));
    if (collection?.url) {
      const link = node('a', 'icon-button'); link.href = collection.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = '查看采集任务'; link.setAttribute('aria-label', link.title); link.append(icon('external')); status.append(link);
    }
  }
  function scheduleCollectionCheck() {
    clearTimeout(collectionTimer);
    if (dialog.open && config && dialog.querySelector('#admin-collect') && (activeCollection() || coolingDown())) collectionTimer = setTimeout(checkCollection, 10000);
  }
  async function checkCollection() {
    if (checking || !config) return;
    checking = true;
    const wasActive = activeCollection();
    try {
      collection = await api('/api/admin/collect'); collectionError = '';
      if (wasActive && collection.status === 'completed' && collection.conclusion === 'success') await onSaved();
    } catch (error) {
      collectionError = error.message;
      if (!config && dialog.open) showLogin(error.message);
    } finally { checking = false; }
    updateCollection(); scheduleCollectionCheck();
  }
  async function save(next, path) {
    config = await api('/api/admin/config', { method: 'PUT', body: JSON.stringify(next) });
    syncEntry(); await onSaved(path);
  }
  function editor(title) {
    clearTimeout(collectionTimer);
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
  function editBoard(board) {
    const view = editor(board ? '编辑榜单' : '新建榜单');
    const name = field('名称', board?.name ?? '', { required: true }); name.input.maxLength = 24;
    const slug = field('路径', board ? boardPath(board) : '', { placeholder: '/example', required: true });
    slug.input.disabled = board?.slug === ''; slug.input.maxLength = 49; slug.input.spellcheck = false;
    view.fields.append(name.wrapper, slug.wrapper);
    view.form.addEventListener('submit', async event => {
      event.preventDefault(); view.submit.disabled = true;
      const next = structuredClone(config);
      const updated = { ...(board ?? { id: `board-${crypto.randomUUID()}`, games: [], authors: [] }), name: name.input.value.trim(), slug: slug.input.value.trim().replace(/^\//, '').replace(/\/$/, '') };
      if (!board && !updated.slug) { setMessage(view.status, '请为新榜单设置独立路径。', true); view.submit.disabled = false; return; }
      if (board) next.boards = next.boards.map(item => item.id === board.id ? updated : item); else next.boards.push(updated);
      try { await save(next, board?.id === getBoardId() ? boardPath(updated) : undefined); boardId = updated.id; showPanel('已保存'); }
      catch (error) { if (!config) showLogin(error.message); else setMessage(view.status, error.message, true); }
      finally { view.submit.disabled = false; }
    });
  }
  function editGame(game) {
    const board = currentBoard();
    const view = editor(`${game ? '编辑游戏' : '添加游戏'} · ${board.name}`);
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
    for (const author of board.authors) { const option = node('option', '', author.name); option.value = author.id; select.append(option); }
    const bound = board.authors.filter(author => author.gameIds.includes(game?.appId));
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
      if (!game && board.games.some(item => item.appId === appId)) { setMessage(view.status, '该游戏已经添加。', true); return; }
      view.submit.disabled = true;
      const next = structuredClone(config);
      const target = currentBoard(next);
      const updated = { ...(game ?? {}), appId, name: name.input.value.trim(), iconUrl: logo.input.value.trim(), totalStartDate: start.input.value };
      if (game) target.games = target.games.map(item => item.appId === game.appId ? updated : item); else target.games.push(updated);
      if (select.value !== '__keep') target.authors.forEach(author => { author.gameIds = author.gameIds.filter(value => value !== appId); if (author.id === select.value) author.gameIds.push(appId); });
      try { await save(next); showPanel(game ? '已保存' : '已添加，可手动采集更新收益'); }
      catch (error) { if (!config) showLogin(error.message); else setMessage(view.status, error.message, true); }
      finally { view.submit.disabled = false; }
    });
  }
  function editAuthor(author) {
    const board = currentBoard();
    const view = editor(`${author ? '编辑作者' : '添加作者'} · ${board.name}`);
    const name = field('昵称', author?.name ?? '', { required: true }); name.input.maxLength = 64;
    const qq = field('QQ 号', author?.qq ?? '', { placeholder: '选填' }); qq.input.inputMode = 'numeric';
    const avatar = field('头像链接', author?.avatarUrl ?? '', { type: 'url', placeholder: '留空使用 QQ 号头像' });
    const tap = field('TapTap 主页', author?.tapUrl ?? '', { type: 'url', placeholder: '选填' });
    view.fields.append(name.wrapper, qq.wrapper, avatar.wrapper, tap.wrapper);
    const bindings = node('fieldset', 'bindings'); bindings.append(node('legend', '', '绑定游戏'));
    const checkboxes = [];
    for (const game of board.games) {
      const label = node('label', 'binding-option'); const input = node('input'); input.type = 'checkbox'; input.value = game.appId; input.checked = author?.gameIds.includes(game.appId) ?? false;
      label.append(input, node('span', '', game.name)); bindings.append(label); checkboxes.push(input);
    }
    if (!board.games.length) bindings.append(node('span', 'value-missing', '请先添加游戏'));
    view.fields.append(bindings);
    view.form.addEventListener('submit', async event => {
      event.preventDefault(); view.submit.disabled = true;
      const next = structuredClone(config);
      const target = currentBoard(next);
      const updated = { id: author?.id ?? `author-${crypto.randomUUID()}`, name: name.input.value.trim(), qq: qq.input.value.trim(), avatarUrl: avatar.input.value.trim(), tapUrl: tap.input.value.trim(), gameIds: checkboxes.filter(input => input.checked).map(input => input.value) };
      if (author) target.authors = target.authors.map(item => item.id === author.id ? updated : item); else target.authors.push(updated);
      try { await save(next); showPanel('已保存'); }
      catch (error) { if (!config) showLogin(error.message); else setMessage(view.status, error.message, true); }
      finally { view.submit.disabled = false; }
    });
  }
  entry.addEventListener('click', async () => {
    if (!dialog.open) dialog.showModal();
    if (!token) { showLogin(); return; }
    dialog.replaceChildren(header('管理'), message('正在加载'));
    try { config = await api('/api/admin/config'); syncEntry(); selectCurrentBoard(); showPanel(); checkCollection(); }
    catch (error) { showLogin(error.message); }
  });
  dialog.addEventListener('close', () => { clearTimeout(collectionTimer); if (!config) dialog.replaceChildren(); });
  syncEntry();
  if (token) api('/api/admin/config').then(data => { config = data; syncEntry(); }).catch(() => { token = ''; remember(); });
}
