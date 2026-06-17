const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
let current = { type: 'clear' };
let pulseStart = Date.now();

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

  if (type === 'callout') {
    drawMessage(current.message || 'Checking screen…', current.confidence);
    if (current.highlight) drawAnimatedArrow(current.highlight);
    return;
  }

  // dom-highlight / vision-highlight
  const rect = current.highlight || current.anchor?.rect;
  if (rect) {
    drawHighlight(rect, current.label || current.message || 'Click here', current.confidence);
    drawAnimatedArrow(rect);
  }
  drawEvidenceBadge(current);
}

function drawHighlight(rect, label, confidence) {
  const x = rect.x;
  const y = rect.y;
  const w = rect.w;
  const h = rect.h;
  const t = (Date.now() - pulseStart) / 1000;
  const pulse = Math.sin(t * Math.PI * 1.8) * 0.5 + 0.5;

  ctx.save();
  ctx.lineWidth = 3 + pulse * 2;
  ctx.strokeStyle = 'rgba(255, 138, 0, 0.96)';
  ctx.fillStyle = `rgba(255, 138, 0, ${0.06 + pulse * 0.08})`;
  roundRect(ctx, x - 6, y - 6, w + 12, h + 12, 12);
  ctx.fill();
  ctx.stroke();

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 7);
  ctx.stroke();

  drawLabel(label, x, Math.max(18, y - 48), confidence);
  ctx.restore();
}

function drawAnimatedArrow(rect) {
  if (!rect) return;
  const cx = rect.x + rect.w / 2;
  const ty = rect.y - 8;           // tip just above the element top
  const t = (Date.now() - pulseStart) / 600; // cycle ~600ms

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 3 cascading chevrons, each offset by 1/3 of the cycle
  for (let i = 0; i < 3; i++) {
    const phase = ((t - i * 0.33) % 1 + 1) % 1;  // 0→1 cycling
    const alpha = Math.sin(phase * Math.PI);        // fade in then out
    const dropY = i * 18 - phase * 14;             // cascade downward as they fade

    ctx.globalAlpha = alpha * 0.92;
    ctx.strokeStyle = 'rgba(255, 138, 0, 1)';
    ctx.lineWidth = 4 - i * 0.6;

    const chevronW = 22 - i * 3;
    const chevronH = 12;
    const baseY = ty - 50 + dropY;

    ctx.beginPath();
    ctx.moveTo(cx - chevronW, baseY);
    ctx.lineTo(cx, baseY + chevronH);
    ctx.lineTo(cx + chevronW, baseY);
    ctx.stroke();
  }

  ctx.restore();
}

function drawLabel(text, x, y, confidence) {
  const safeText = String(text || 'Next step').replace(/\*\*/g, '').slice(0, 50);
  const confText = typeof confidence === 'number' ? `  ${(confidence * 100).toFixed(0)}%` : '';
  const full = safeText + confText;
  ctx.save();
  ctx.font = '700 15px Inter, system-ui, sans-serif';
  const metrics = ctx.measureText(full);
  const boxW = Math.min(window.innerWidth - 32, metrics.width + 28);
  const boxH = 34;
  const bx = Math.max(16, Math.min(window.innerWidth - boxW - 16, x));
  const by = Math.max(16, Math.min(window.innerHeight - boxH - 16, y));
  ctx.fillStyle = 'rgba(20, 20, 24, 0.90)';
  ctx.strokeStyle = 'rgba(255, 138, 0, 0.90)';
  ctx.lineWidth = 2;
  roundRect(ctx, bx, by, boxW, boxH, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillText(full, bx + 14, by + 22);
  ctx.restore();
}

function drawMessage(text, confidence) {
  const message = String(text || 'Checking screen…').replace(/\*\*/g, '').slice(0, 80);
  ctx.save();
  ctx.font = '700 18px Inter, system-ui, sans-serif';
  const lines = wrapText(message, 44);
  const w = Math.min(560, window.innerWidth - 48);
  const h = 58 + lines.length * 24;
  const x = Math.round((window.innerWidth - w) / 2);
  const y = Math.round(window.innerHeight * 0.13);

  // subtle border pulse
  const t = (Date.now() - pulseStart) / 1000;
  const pulse = Math.sin(t * Math.PI * 1.4) * 0.5 + 0.5;
  ctx.fillStyle = 'rgba(20, 20, 24, 0.92)';
  ctx.strokeStyle = `rgba(255, 138, 0, ${0.70 + pulse * 0.25})`;
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  lines.forEach((line, i) => ctx.fillText(line, x + 22, y + 38 + i * 24));
  if (typeof confidence === 'number') {
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.60)';
    ctx.fillText(`confidence ${(confidence * 100).toFixed(0)}%`, x + 22, y + h - 14);
  }
  ctx.restore();
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

// 60ms = ~16fps, smooth enough for animation without heavy CPU
setInterval(() => {
  if (current && current.type !== 'clear') draw();
}, 60);
