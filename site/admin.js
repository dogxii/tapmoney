import { node, portrait, iconButton, icon } from './ui.js';
import { boardPath } from '../shared/boards.mjs';

export function initAdmin({ onSaved, getBoardId }) {
  const dialog = document.querySelector('#admin-dialog');
  dialog.setAttribute('aria-label', '管理');
  const entry = document.querySelector('#manage-open');
  let token = '', config, boardId, tab = 'games';
  let listPage = 0, listSearch = '';
  const currentBoard = (value = config) => value.boards.find(board => board.id === boardId) ?? value.boards.find(board => board.slug === '');
  const selectCurrentBoard = () => { boardId = getBoardId() ?? config.boards.find(board => board.slug === '').id; };
  let collection, collectionError = '', collecting = false, checking = false, collectionTimer;
  const activeCollection = () => ['requested', 'queued', 'in_progress', 'waiting', 'pending'].includes(collection?.status);
  const coolingDown = () => Date.parse(collection?.nextAllowedAt) > Date.now();
  try { token = sessionStorage.getItem('tapmoney-admin') ?? ''; } catch { /* 可仅使用内存登录 */ }
  const remember = () => { try { if (token) sessionStorage.setItem('tapmoney-admin', token); else sessionStorage.removeItem('tapmoney-admin'); } catch { /* 存储不可用 */ } };
  const syncEntry = () => { entry.replaceChildren(icon(config ? 'edit' : 'plus')); entry.title = config ? '管理榜单' : '管理'; entry.setAttribute('aria-label', entry.title); };
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
      select.value = board.id; select.addEventListener('change', () => { boardId = select.value; listPage = 0; listSearch = ''; showPanel(); }); scope.append(select); dialog.append(scope);
    }
    const toolbar = node('div', 'admin-toolbar');
    const tabs = node('div', 'tabs');
    for (const [key, title] of [['games', '游戏'], ['boards', '榜单']]) {
      const button = node('button', key === tab ? 'active' : '', title); button.type = 'button'; button.setAttribute('aria-pressed', String(key === tab));
      button.addEventListener('click', () => { tab = key; listPage = 0; listSearch = ''; showPanel(); }); tabs.append(button);
    }
    const add = node('button', 'secondary-button'); add.type = 'button'; add.append(icon('plus'), document.createTextNode(tab === 'games' ? '添加游戏' : '新建榜单'));
    add.addEventListener('click', () => tab === 'games' ? addGame() : editBoard());
    const collect = iconButton('refresh', '采集下一批'); collect.id = 'admin-collect';
    collect.addEventListener('click', async () => {
      collecting = true; collectionError = ''; updateCollection();
      try { collection = await api('/api/admin/collect', { method: 'POST' }); }
      catch (error) { collectionError = error.message; if (!config) { showLogin(error.message); return; } }
      finally { collecting = false; }
      updateCollection(); scheduleCollectionCheck();
    });
    const tools = node('div', 'dialog-actions'); tools.append(collect, add); toolbar.append(tabs, tools);
    const list = node('div', 'admin-list');
    const search = field('搜索游戏', listSearch, {type:'search'}); search.wrapper.hidden = tab !== 'games';
    const pagination = node('nav', 'pagination admin-pagination'); pagination.setAttribute('aria-label','管理列表分页');
    const previous = iconButton('arrow','上一页'), nextPage = iconButton('arrow','下一页'), position = node('span');
    previous.style.transform = 'rotate(90deg)'; nextPage.style.transform = 'rotate(-90deg)';
    pagination.append(previous,position,nextPage);
    previous.addEventListener('click',()=>{listPage--;renderList();}); nextPage.addEventListener('click',()=>{listPage++;renderList();});
    search.input.addEventListener('input',()=>{listSearch=search.input.value;listPage=0;renderList();});
    function renderList() {
      list.replaceChildren();
      const query = listSearch.trim().toLocaleLowerCase();
      const items = (tab === 'boards' ? config.boards : board.games).filter(item=>tab === 'boards' || `${item.name} ${item.appId}`.toLocaleLowerCase().includes(query));
      const pages = Math.max(1, Math.ceil(items.length / 100)); listPage = Math.min(listPage, pages - 1);
      pagination.hidden = pages < 2; position.textContent=`${listPage+1} / ${pages}`;previous.disabled=listPage===0;nextPage.disabled=listPage===pages-1;
      for (const item of items.slice(listPage*100,(listPage+1)*100)) {
        const row = node('div', 'admin-row');
        if (tab !== 'boards') row.append(portrait(item.iconUrl, item.name, 'game-logo'));
        const text = node('div', 'admin-row-text'); text.append(node('strong', '', item.name));
        text.append(node('span', '', tab === 'games' ? item.appId : `${boardPath(item)} · ${item.games.length} 款游戏`)); row.append(text);
        const remove = iconButton('trash', `删除${item.name}`);
        remove.addEventListener('click', async () => {
          if (!window.confirm(tab === 'boards' ? `删除「${item.name}」及该榜的游戏配置？` : `从「${board.name}」删除「${item.name}」？`)) return;
          remove.disabled = true;
          const next = structuredClone(config);
          const target = currentBoard(next);
          if (tab === 'games') target.games = target.games.filter(game => game.appId !== item.appId);
          else next.boards = next.boards.filter(board => board.id !== item.id);
          try { await save(next, tab === 'boards' && item.id === getBoardId() ? '/' : undefined); showPanel('已删除'); }
          catch (error) { if (!config) showLogin(error.message); else showPanel(error.message); }
        });
        const actions = node('div', 'dialog-actions'); if (tab === 'boards') { const edit = iconButton('edit', `编辑${item.name}`); edit.addEventListener('click', () => editBoard(item)); actions.append(edit); } if (tab !== 'boards' || item.slug !== '') actions.append(remove); row.append(actions); list.append(row);
      }
      if (!items.length) list.append(node('div', 'empty', '暂无游戏'));
    }
    renderList();
    const collectionStatus = node('div', 'admin-collection'); collectionStatus.id = 'admin-collection-status'; collectionStatus.setAttribute('role', 'status');
    dialog.append(toolbar, search.wrapper, list, pagination, collectionStatus, message(feedback));
    updateCollection(); scheduleCollectionCheck();
  }
  function updateCollection() {
    const button = dialog.querySelector('#admin-collect');
    const status = dialog.querySelector('#admin-collection-status');
    if (!button || !status) return;
    const busy = collecting || activeCollection();
    button.disabled = !collection?.enabled || busy || coolingDown();
    button.classList.toggle('collecting', busy);
    button.title = collection?.enabled === false ? '手动采集尚未配置' : busy ? '采集进行中' : coolingDown() ? '请稍后再采集' : '采集下一批';
    status.replaceChildren();
    const labels = { requested: '等待采集', queued: '采集排队中', in_progress: '采集中', waiting: '等待采集', pending: '等待采集' };
    let text = collectionError || (collecting ? '正在提交' : labels[collection?.status] ?? '');
    if (!text && collection?.status === 'completed') text = collection.conclusion === 'success' ? '本批采集完成' : collection.conclusion === 'cancelled' ? '采集已取消' : '采集失败';
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
  function addGame() {
    const board = currentBoard();
    const view = editor(`添加游戏 · ${board.name}`);
    const id = field('游戏 ID / TapTap 链接', '', { required: true });
    const preview = node('div', 'game-preview'); preview.hidden = true;
    view.fields.append(id.wrapper, preview); view.submit.textContent = '获取资料';
    let metadata;
    id.input.addEventListener('input', () => { metadata = undefined; preview.hidden = true; view.submit.textContent = '获取资料'; setMessage(view.status, ''); });
    view.form.addEventListener('submit', async event => {
      event.preventDefault();
      const appId = gameId(id.input.value);
      if (!appId) { setMessage(view.status, '请输入有效的游戏 ID 或 TapTap 链接。', true); return; }
      if (board.games.some(item => item.appId === appId)) { setMessage(view.status, '该游戏已经添加。', true); return; }
      view.submit.disabled = true;
      try {
        if (metadata?.appId !== appId) {
          const data = await api(`/api/admin/game?id=${appId}`);
          if (gameId(id.input.value) !== appId || !dialog.contains(preview)) return;
          metadata = data;
          const text = node('div', 'admin-row-text'); text.append(node('strong', '', data.name), node('span', '', (data.authors ?? []).map(author => author.name).join(' / ')));
          preview.replaceChildren(portrait(data.iconUrl, data.name, 'game-logo'), text); preview.hidden = false;
          view.submit.textContent = '添加'; setMessage(view.status, '');
          return;
        }
        const next = structuredClone(config);
        currentBoard(next).games.push({appId, name: metadata.name, ...(metadata.iconUrl ? {iconUrl:metadata.iconUrl} : {}), totalStartDate:'2020-01-01'});
        await save(next); showPanel('已添加，可手动采集更新收益');
      } catch (error) { if (!config) showLogin(error.message); else setMessage(view.status, error.message, true); }
      finally { view.submit.disabled = false; }
    });
  }
  const open = async () => {
    if (!dialog.open) dialog.showModal();
    if (!token) { showLogin(); return; }
    dialog.replaceChildren(header('管理'), message('正在加载'));
    try { config = await api('/api/admin/config'); syncEntry(); selectCurrentBoard(); showPanel(); checkCollection(); }
    catch (error) { showLogin(error.message); }
  };
  dialog.addEventListener('close', () => { clearTimeout(collectionTimer); if (!config) dialog.replaceChildren(); });
  syncEntry();
  return open;
}
