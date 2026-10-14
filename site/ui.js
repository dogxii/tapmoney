export const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function safeImage(value) {
  if (typeof value === 'string' && /^\/media\/[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}

export function portrait(url, label, className) {
  const container = node('span', className);
  const fallback = node('span', '', String(label).slice(0, 1));
  fallback.setAttribute('aria-hidden', 'true');
  container.append(fallback);
  if (safeImage(url)) {
    const image = node('img');
    image.src = url; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => { fallback.hidden = true; });
    image.addEventListener('error', () => { image.remove(); fallback.hidden = false; });
    container.prepend(image);
  }
  return container;
}

export function authorLink(author) {
  let validUrl = null;
  try {
    const url = new URL(author.tapUrl);
    if (url.protocol === 'https:' && ['www.taptap.cn', 'taptap.cn'].includes(url.hostname) && /^\/(user|developer)\/\d+\/?$/.test(url.pathname)) validUrl = url.href;
  } catch { /* 未绑定主页时展示头像和昵称。 */ }
  const link = node(validUrl ? 'a' : 'span', 'row-author');
  if (validUrl) { link.href = validUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = `${author.name} · TapTap`; }
  link.append(portrait(author.avatarUrl, author.name, 'avatar'), node('span', 'author-name', author.name));
  return link;
}

export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add(className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function iconButton(name, label) {
  const button = node('button', 'icon-button');
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.append(icon(name));
  return button;
}
