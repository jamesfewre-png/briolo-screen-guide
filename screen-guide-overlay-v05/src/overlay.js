const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
let current = { type: 'clear' };
let pulseStart = Date.now();

const navBtn = document.getElementById('navBtn');
const navLink = document.getElementById('navLink');
let navDismissTimer = null;

function showNavigate(url, label) {
  navLink.textContent = `Open ${label || 'page'} →`;
  navLink.onclick = () => { window.overlayBridge.openUrl(url); hideNavigate(); };
  navBtn.style.display = 'block';
  if (navDismissTimer) clearTimeout(navDismissTimer);
  navDismissTimer = setTimeout(hideNavigate, 10000);
}

function hideNavigate() {
  if (navBtn.style.display === 'none') return;
  navBtn.style.display = 'none';
  if (navDismissTimer) { clearTimeout(navDismissTimer); navDismissTimer = null; }
  window.overlayBridge.notifyNavigated();
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

window.addEventListener('resize', resize);
resize();

window.overlayBridge.onUpdate((guidance) => {
  current = guidance || { type: 'clear' };
  pulseStart = Date.now();
  if (current.type !== 'navigate') hideNavigate();
  draw();
});

function clear() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

function draw() {
  clear();
  if (!current || current.type === 'clear') return;

  const type = current.type;
  if (type === 'message') {
    drawMessage(current.message || 'Checking screen…', current.confidence);
    return;
  }

  if (type === 'navigate') {
    drawMessage(current.message || 'Wrong page', current.confidence);
    if (current.url) showNavigate(current.url, current.urlLabel || 'page');
    return;
  }

  if (type === 'callout') {
    drawMessage(current.message || 'Checking screen…', current.confidence);
    drawArrow(current.arrow || { direction: 'down', x: 0.5, y: 0.75 }, null);
    return;
  }

  const rect = current.highlight || current.anchor?.rect;
  if (rect) drawHighlight(rect, current.label || current.message || 'Click here', current.confidence);
  drawArrow(current.arrow || null, rect);
  drawEvidenceBadge(current);
}

function drawHighlight(rect, label, confidence) {
  const x = rect.x;
  const y = rect.y;
  const w = rect.w;
  const h = rect.h;
  const pulse = Math.sin((Date.now() - pulseStart) / 180) * 0.5 + 0.5;

  ctx.save();
  ctx.lineWidth = 4 + pulse * 2;
  ctx.strokeStyle = 'rgba(255, 138, 0, 0.96)';
  ctx.fillStyle = 'rgba(255, 138, 0, 0.10)';
  roundRect(ctx, x - 8, y - 8, w + 16, h + 16, 14);
  ctx.fill();
  ctx.stroke();

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  roundRect(ctx, x - 2, y - 2, w + 4, h + 4, 8);
  ctx.stroke();

  drawLabel(label, x, Math.max(18, y - 52), confidence);
  ctx.restore();
}

function drawLabel(text, x, y, confidence) {
  const safeText = String(text || 'Next step').slice(0, 90);
  const confText = typeof confidence === 'number' ? `  ${(confidence * 100).toFixed(0)}%` : '';
  const full = safeText + confText;
  ctx.save();
  ctx.font = '700 16px Inter, system-ui, sans-serif';
  const metrics = ctx.measureText(full);
  const boxW = Math.min(window.innerWidth - 32, metrics.width + 28);
  const boxH = 38;
  const bx = Math.max(16, Math.min(window.innerWidth - boxW - 16, x));
  const by = Math.max(16, Math.min(window.innerHeight - boxH - 16, y));
  ctx.fillStyle = 'rgba(20, 20, 24, 0.92)';
  ctx.strokeStyle = 'rgba(255, 138, 0, 0.95)';
  ctx.lineWidth = 2;
  roundRect(ctx, bx, by, boxW, boxH, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillText(full, bx + 14, by + 24);
  ctx.restore();
}

function drawMessage(text, confidence) {
  const message = String(text || 'Checking screen…').slice(0, 160);
  ctx.save();
  ctx.font = '700 18px Inter, system-ui, sans-serif';
  const lines = wrapText(message, 44);
  const w = Math.min(560, window.innerWidth - 48);
  const h = 58 + lines.length * 24;
  const x = Math.round((window.innerWidth - w) / 2);
  const y = Math.round(window.innerHeight * 0.13);
  ctx.fillStyle = 'rgba(20, 20, 24, 0.92)';
  ctx.strokeStyle = 'rgba(255, 138, 0, 0.92)';
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  lines.forEach((line, i) => ctx.fillText(line, x + 22, y + 38 + i * 24));
  if (typeof confidence === 'number') {
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText(`confidence ${(confidence * 100).toFixed(0)}%`, x + 22, y + h - 14);
  }
  ctx.restore();
}

function drawArrow(arrow, rect) {
  if (!arrow && !rect) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 138, 0, 0.95)';
  ctx.fillStyle = 'rgba(255, 138, 0, 0.95)';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let endX, endY, startX, startY;
  if (rect) {
    endX = rect.x + rect.w / 2;
    endY = rect.y + rect.h / 2;
    startX = endX - 170;
    startY = Math.max(80, endY - 120);
  } else {
    endX = (arrow.x || 0.5) * window.innerWidth;
    endY = (arrow.y || 0.5) * window.innerHeight;
    startX = endX;
    startY = arrow.direction === 'down' ? endY - 160 : endY + 160;
  }

  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.quadraticCurveTo((startX + endX) / 2, startY, endX, endY);
  ctx.stroke();

  const angle = Math.atan2(endY - startY, endX - startX);
  drawArrowHead(endX, endY, angle);
  ctx.restore();
}

function drawArrowHead(x, y, angle) {
  const len = 28;
  const a1 = angle - Math.PI / 7;
  const a2 = angle + Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - len * Math.cos(a1), y - len * Math.sin(a1));
  ctx.lineTo(x - len * Math.cos(a2), y - len * Math.sin(a2));
  ctx.closePath();
  ctx.fill();
}

function drawEvidenceBadge(guidance) {
  const evidence = guidance.evidence || guidance.anchor?.evidence || {};
  const source = guidance.anchor?.strategy || guidance.type || 'overlay';
  const bits = [];
  if (evidence.url_present) bits.push('URL');
  if (evidence.dom_present) bits.push('DOM');
  if (evidence.selector_found) bits.push('selector');
  if (evidence.screen_rect_found) bits.push('bounds');
  const label = bits.length ? `grounded: ${bits.join(' + ')}` : source;

  ctx.save();
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  const w = ctx.measureText(label).width + 22;
  const x = window.innerWidth - w - 20;
  const y = window.innerHeight - 42;
  ctx.fillStyle = 'rgba(20,20,24,0.74)';
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  roundRect(ctx, x, y, w, 28, 999);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.76)';
  ctx.fillText(label, x + 11, y + 18);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

setInterval(() => {
  if (current && current.type !== 'clear' && (current.highlight || current.anchor?.rect)) draw();
}, 120);
