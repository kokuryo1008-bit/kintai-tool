const token = localStorage.getItem('token');
const name = localStorage.getItem('name');
if (!token) location.href = '/';

document.getElementById('user-name').textContent = name || '';

// ── 時計 ──
function updateClock() {
  const now = new Date();
  document.getElementById('current-time').textContent = now.toLocaleTimeString('ja-JP');
  document.getElementById('current-date').textContent = now.toLocaleDateString('ja-JP', { year:'numeric', month:'long', day:'numeric', weekday:'short' });
}
setInterval(updateClock, 1000);
updateClock();

// ── セレクトボックス初期化 ──
(function initSelects() {
  const now = new Date();
  const ysel = document.getElementById('hist-year');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (y === now.getFullYear()) o.selected = true;
    ysel.appendChild(o);
  }
  const msel = document.getElementById('hist-month');
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + '月';
    if (m === now.getMonth() + 1) o.selected = true;
    msel.appendChild(o);
  }
})();

// ── GPS ──
let currentPos = null;
function getGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { resolve(null); return; }
    const warn = document.getElementById('gps-warning');
    warn.classList.remove('hidden');
    navigator.geolocation.getCurrentPosition(
      pos => {
        warn.classList.add('hidden');
        currentPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        resolve(currentPos);
      },
      err => {
        warn.querySelector('div').textContent = '📍 GPS取得失敗';
        warn.querySelector('div:last-child').textContent = err.message;
        resolve(null);
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  });
}

// ── 今日のシフト ──
async function loadTodayShift() {
  try {
    const res = await api('/api/shifts/today');
    const d = await res.json();
    const el = document.getElementById('today-shift');
    if (d.start_time) {
      el.textContent = `📅 本日のシフト: ${d.start_time.slice(0,5)} 〜 ${d.end_time.slice(0,5)}`;
    } else {
      el.textContent = '';
    }
  } catch(e) {}
}
loadTodayShift();

// ── 今日の状態読み込み ──
async function loadTodayStatus() {
  try {
    const res = await api('/api/attendance/today');
    const d = await res.json();
    if (!res.ok) return;

    const btnIn = document.getElementById('btn-in');
    const btnOut = document.getElementById('btn-out');
    const status = document.getElementById('clock-status');

    document.getElementById('disp-in').textContent = d.clock_in ? d.clock_in.slice(0,5) : '--:--';
    document.getElementById('disp-out').textContent = d.clock_out ? d.clock_out.slice(0,5) : '--:--';
    document.getElementById('disp-work').textContent = d.work_minutes != null ? fmtMin(d.work_minutes) : '--';
    document.getElementById('disp-ot').textContent = d.overtime_minutes != null ? fmtMin(d.overtime_minutes) : '--';

    if (!d.clock_in) {
      status.textContent = '未出勤';
      btnIn.disabled = false; btnOut.disabled = true;
    } else if (!d.clock_out) {
      status.textContent = '出勤中 🟢';
      btnIn.disabled = true; btnOut.disabled = false;
    } else {
      status.textContent = '退勤済 ✅';
      btnIn.disabled = true; btnOut.disabled = true;
    }
  } catch(e) {
    document.getElementById('clock-status').textContent = '読み込みエラー';
  }
}
loadTodayStatus();

// ── 出張モード ──
function isTrip() {
  return document.getElementById('toggle-trip').checked;
}
function updateTripMode() {
  const trip = isTrip();
  const card = document.querySelector('.clock-card');
  card.style.background = trip ? 'linear-gradient(135deg,#1E3A5F,#0369A1)' : '';
  document.getElementById('clock-status').textContent = trip ? '✈️ 出張モード（GPS解除）' : '読み込み中...';
  if (trip) loadTodayStatus();
}

// ── 出勤 ──
async function clockIn() {
  const btn = document.getElementById('btn-in');
  btn.disabled = true; btn.textContent = '取得中...';
  const trip = isTrip();
  const pos = trip ? null : await getGPS();
  try {
    const body = { location_type: trip ? 'business_trip' : 'office' };
    if (pos) { body.lat = pos.lat; body.lon = pos.lon; }
    const res = await api('/api/attendance/clock-in', 'POST', body);
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); btn.disabled = false; btn.textContent = '出勤'; return; }
    await loadTodayStatus();
  } catch(e) { alert('通信エラーが発生しました'); btn.disabled = false; btn.textContent = '出勤'; }
}

// ── 退勤 ──
async function clockOut() {
  const btn = document.getElementById('btn-out');
  btn.disabled = true; btn.textContent = '取得中...';
  const trip = isTrip();
  const pos = trip ? null : await getGPS();
  try {
    const body = { location_type: trip ? 'business_trip' : 'office' };
    if (pos) { body.lat = pos.lat; body.lon = pos.lon; }
    const res = await api('/api/attendance/clock-out', 'POST', body);
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); btn.disabled = false; btn.textContent = '退勤'; return; }
    await loadTodayStatus();
  } catch(e) { alert('通信エラーが発生しました'); btn.disabled = false; btn.textContent = '退勤'; }
}

// ── 勤務履歴 ──
async function loadHistory() {
  const year = document.getElementById('hist-year').value;
  const month = document.getElementById('hist-month').value;
  try {
    const res = await api(`/api/attendance/history?year=${year}&month=${month}`);
    const d = await res.json();
    if (!res.ok) return;
    const tbody = document.getElementById('hist-body');
    tbody.innerHTML = '';
    let totalWork = 0, totalOt = 0;
    (d.records || []).forEach(r => {
      totalWork += r.work_minutes || 0;
      totalOt += r.overtime_minutes || 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.date}</td>
        <td>${r.clock_in ? r.clock_in.slice(0,5) : '--'}</td>
        <td>${r.clock_out ? r.clock_out.slice(0,5) : '--'}</td>
        <td>${r.work_minutes != null ? fmtMin(r.work_minutes) : '--'}</td>
        <td style="color:var(--warning)">${r.overtime_minutes ? fmtMin(r.overtime_minutes) : '--'}</td>
      `;
      tbody.appendChild(tr);
    });
    document.getElementById('sum-work').textContent = fmtMin(totalWork);
    document.getElementById('sum-ot').textContent = fmtMin(totalOt);
  } catch(e) {}
}
loadHistory();

// ── 有給申請 ──
async function loadLeaveInfo() {
  try {
    const res = await api('/api/leave/remaining');
    const d = await res.json();
    if (res.ok) document.getElementById('leave-remaining').textContent = d.remaining_days;
    const res2 = await api('/api/leave/history');
    const d2 = await res2.json();
    if (!res2.ok) return;
    const el = document.getElementById('leave-history');
    el.innerHTML = '';
    (d2.requests || []).forEach(r => {
      const div = document.createElement('div');
      div.style.cssText = 'padding:10px;border-radius:8px;background:#F8FAFC;margin-bottom:8px;font-size:0.85rem';
      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>${r.start_date} ～ ${r.end_date}（${r.days}日）</span>
          <span class="badge ${statusBadge(r.status)}">${statusLabel(r.status)}</span>
        </div>
        ${r.reason ? `<div style="color:var(--text-muted);margin-top:4px">${r.reason}</div>` : ''}
      `;
      el.appendChild(div);
    });
    if (!d2.requests?.length) el.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">申請履歴はありません</div>';
  } catch(e) {}
}

async function submitLeave() {
  const start = document.getElementById('leave-start').value;
  const end = document.getElementById('leave-end').value;
  const days = document.getElementById('leave-days').value;
  const reason = document.getElementById('leave-reason').value;
  if (!start || !end || !days) { alert('開始日・終了日・取得日数を入力してください'); return; }
  try {
    const res = await api('/api/leave/request', 'POST', { start_date: start, end_date: end, days: parseFloat(days), reason });
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); return; }
    alert('申請しました');
    document.getElementById('leave-start').value = '';
    document.getElementById('leave-end').value = '';
    document.getElementById('leave-days').value = '';
    document.getElementById('leave-reason').value = '';
    loadLeaveInfo();
  } catch(e) { alert('通信エラーが発生しました'); }
}

// ── 出張申請 ──
async function loadTripHistory() {
  try {
    const res = await api('/api/trips/history');
    const d = await res.json();
    if (!res.ok) return;
    const el = document.getElementById('trip-history');
    el.innerHTML = '';
    (d.requests || []).forEach(r => {
      const div = document.createElement('div');
      div.style.cssText = 'padding:10px;border-radius:8px;background:#F8FAFC;margin-bottom:8px;font-size:0.85rem';
      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>${r.trip_date} ${r.destination}</span>
          <span class="badge ${statusBadge(r.status)}">${statusLabel(r.status)}</span>
        </div>
        ${r.reason ? `<div style="color:var(--text-muted);margin-top:4px">${r.reason}</div>` : ''}
      `;
      el.appendChild(div);
    });
    if (!d.requests?.length) el.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">申請履歴はありません</div>';
  } catch(e) {}
}

async function submitTrip() {
  const date = document.getElementById('trip-date').value;
  const dest = document.getElementById('trip-dest').value;
  const reason = document.getElementById('trip-reason').value;
  if (!date || !dest) { alert('出張日と出張先を入力してください'); return; }
  try {
    const res = await api('/api/trips/request', 'POST', { trip_date: date, destination: dest, reason });
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); return; }
    alert('申請しました');
    document.getElementById('trip-date').value = '';
    document.getElementById('trip-dest').value = '';
    document.getElementById('trip-reason').value = '';
    loadTripHistory();
  } catch(e) { alert('通信エラーが発生しました'); }
}

// ── タブ ──
function showTab(name) {
  ['history','leave'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('hidden', t !== name);
  });
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['history','leave'][i] === name);
  });
  if (name === 'leave') loadLeaveInfo();
}

// ── ログアウト ──
function logout() {
  localStorage.clear();
  location.href = '/';
}

// ── ユーティリティ ──
function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { Authorization: 'Bearer ' + token } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(path, opts);
}

function fmtMin(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + 'h' + (m ? m + 'm' : '');
}

function statusLabel(s) {
  return { pending:'申請中', approved:'承認済', rejected:'却下' }[s] || s;
}

function statusBadge(s) {
  return { pending:'badge-yellow', approved:'badge-green', rejected:'badge-red' }[s] || 'badge-gray';
}
