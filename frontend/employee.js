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
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    // HTTP環境ではGeolocation APIがブロックされるため静かにスキップ
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      resolve(null); return;
    }
    const warn = document.getElementById('gps-warning');
    warn.classList.remove('hidden');
    navigator.geolocation.getCurrentPosition(
      pos => {
        warn.classList.add('hidden');
        currentPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        resolve(currentPos);
      },
      () => {
        warn.classList.add('hidden');
        resolve(null);
      },
      { timeout: 8000, enableHighAccuracy: true }
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
  ['history','shift','leave','report','sales','overtime'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('hidden', t !== name);
  });
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['history','shift','leave','report','sales','overtime'][i] === name);
  });
  if (name === 'shift') loadShiftTable();
  if (name === 'leave') loadLeaveInfo();
  if (name === 'report') loadReport();
  if (name === 'sales') loadSales();
  if (name === 'overtime') loadOvertime();
}

// ── シフト表 ──
(function initShiftSelects() {
  const now = new Date();
  const ysel = document.getElementById('shift-emp-year');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 1; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (y === now.getFullYear()) o.selected = true;
    ysel.appendChild(o);
  }
  // 翌月まで選択可能
  for (let y = now.getFullYear(); y <= now.getFullYear() + 1; y++) {
    const exists = [...ysel.options].some(o => o.value == y);
    if (!exists) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y + '年';
      ysel.appendChild(o);
    }
  }
  const msel = document.getElementById('shift-emp-month');
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + '月';
    if (m === now.getMonth() + 1) o.selected = true;
    msel.appendChild(o);
  }
})();

const myEmployeeId = localStorage.getItem('employee_id');

async function loadShiftTable() {
  const year = document.getElementById('shift-emp-year').value;
  const month = document.getElementById('shift-emp-month').value;
  try {
    const res = await api(`/api/shifts?year=${year}&month=${month}`);
    const d = await res.json();
    if (!res.ok) return;
    renderShiftTable(d.shifts || [], parseInt(year), parseInt(month));
  } catch(e) {}
}

function renderShiftTable(shifts, year, month) {
  const thead = document.getElementById('shift-emp-thead');
  const tbody = document.getElementById('shift-emp-tbody');

  const daysInMonth = new Date(year, month, 0).getDate();
  const DOW = ['日','月','火','水','木','金','土'];

  // 日付ヘッダー
  let headHtml = '<tr><th style="position:sticky;left:0;background:#F8FAFC;z-index:1;white-space:nowrap;padding:6px 10px;border:1px solid #E2E8F0">氏名</th>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    const dow = dt.getDay();
    const color = dow === 0 ? 'color:#EF4444' : dow === 6 ? 'color:#3B82F6' : '';
    headHtml += `<th style="min-width:54px;text-align:center;padding:4px 2px;border:1px solid #E2E8F0;${color}">${d}<br><span style="font-size:0.7rem">${DOW[dow]}</span></th>`;
  }
  headHtml += '</tr>';
  thead.innerHTML = headHtml;

  // 従業員ごとにシフトをまとめる
  const empMap = {};
  shifts.forEach(s => {
    const key = s.employee_id;
    if (!empMap[key]) empMap[key] = { name: s.name, department: s.department, dates: {} };
    empMap[key].dates[s.shift_date] = { start: s.start_time, end: s.end_time };
  });

  if (!Object.keys(empMap).length) {
    tbody.innerHTML = `<tr><td colspan="${daysInMonth + 1}" style="text-align:center;color:#94A3B8;padding:20px">シフトが登録されていません</td></tr>`;
    return;
  }

  let bodyHtml = '';
  Object.entries(empMap).forEach(([empId, emp]) => {
    const isMe = empId === myEmployeeId;
    const rowBg = isMe ? 'background:#EFF6FF' : '';
    bodyHtml += `<tr style="${rowBg}">`;
    bodyHtml += `<td style="position:sticky;left:0;background:${isMe ? '#EFF6FF' : '#F8FAFC'};z-index:1;white-space:nowrap;padding:6px 10px;border:1px solid #E2E8F0;font-weight:${isMe ? '700' : '400'}">${emp.name}${isMe ? ' 👤' : ''}</td>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const shift = emp.dates[dateStr];
      if (shift) {
        bodyHtml += `<td style="text-align:center;padding:3px 2px;border:1px solid #E2E8F0;font-size:0.7rem;white-space:nowrap;background:${isMe ? '#DBEAFE' : '#F0FDF4'};color:${isMe ? '#1D4ED8' : '#065F46'}">${shift.start.slice(0,5)}<br>${shift.end.slice(0,5)}</td>`;
      } else {
        bodyHtml += `<td style="border:1px solid #E2E8F0"></td>`;
      }
    }
    bodyHtml += '</tr>';
  });
  tbody.innerHTML = bodyHtml;
}

// ── 日報 ──
const WORK_CODES = [
  ['A','部品検品・部品注文・払出・部品確認'],
  ['B','タクト図面,プログラム作成・確認'],
  ['C','部品セッティング(SMD/手載せ)'],
  ['D','SMD/手載せ/リフロー（1st）'],
  ['E','SMD/手載せ/リフロー（2nd）'],
  ['F','部品前準備・DIP部品加工'],
  ['G','マスキングテープ貼り・シール貼り(作成)'],
  ['H','手挿入・自動半田DIP'],
  ['I','後付け・組立・改造'],
  ['J','製品仕上げ(リードカット、清掃)'],
  ['K','初品検査/製品出荷検査'],
  ['L','修正'],
  ['M','返却部品の確認・梱包・伝票処理・発送'],
  ['N','作業指導'],
  ['O','棚卸'],
];

function workCodeLabel(code) {
  if (!code) return '--';
  const entry = WORK_CODES.find(([c]) => c === code);
  return entry ? `${entry[0]}: ${entry[1]}` : code;
}

function buildWorkCodeOptions(selectId, includeO = true) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = '<option value="">-- 選択 --</option>';
  WORK_CODES.forEach(([code, label]) => {
    if (!includeO && code === 'O') return;
    const o = document.createElement('option');
    o.value = code;
    o.textContent = `${code}: ${label}`;
    sel.appendChild(o);
  });
}

function calcMinutes(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
}

(function initRepSelects() {
  const now = new Date();
  const ysel = document.getElementById('rep-year');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (y === now.getFullYear()) o.selected = true;
    ysel.appendChild(o);
  }
  const msel = document.getElementById('rep-month');
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + '月';
    if (m === now.getMonth() + 1) o.selected = true;
    msel.appendChild(o);
  }
  buildWorkCodeOptions('rep-work-code', false);
  buildWorkCodeOptions('rep-other-code', true);
})();

let reportEntries = [];

async function loadReport() {
  const year = document.getElementById('rep-year').value;
  const month = document.getElementById('rep-month').value;
  try {
    const res = await api(`/api/reports/mine?year=${year}&month=${month}`);
    const d = await res.json();
    if (!res.ok) return;
    reportEntries = d.entries || [];
    renderReport();
  } catch(e) {}
}

function renderReport() {
  const tbody = document.getElementById('report-body');
  const tfoot = document.getElementById('report-foot');
  tbody.innerHTML = '';
  let totalBoard = 0, totalOther = 0;
  if (!reportEntries.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:16px">記録がありません</td></tr>';
    tfoot.innerHTML = '';
    return;
  }
  reportEntries.forEach(r => {
    const bMin = calcMinutes(r.board_start, r.board_end);
    const oMin = calcMinutes(r.other_start, r.other_end);
    totalBoard += bMin;
    totalOther += oMin;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="white-space:nowrap">${r.report_date.slice(5).replace('-','/')}</td>
      <td style="background:#F7FAFF">
        ${r.part_number ? `<div style="font-weight:600">${r.part_number}</div>` : ''}
        ${r.estimate_no ? `<div style="font-size:0.72rem;color:var(--text-muted)">見積:${r.estimate_no}</div>` : ''}
        ${!r.part_number && !r.estimate_no ? '--' : ''}
      </td>
      <td style="background:#F7FAFF;font-size:0.72rem">${r.work_code ? `<span style="font-weight:700;color:var(--primary)">${r.work_code}</span> ${WORK_CODES.find(([c])=>c===r.work_code)?.[1]||''}` : '--'}</td>
      <td style="background:#F7FAFF;white-space:nowrap">${r.board_start ? r.board_start.slice(0,5)+'〜'+(r.board_end||'').slice(0,5) : '--'}</td>
      <td style="background:#F0FDF4;font-size:0.72rem">${r.other_code ? `<span style="font-weight:700;color:#059669">${r.other_code}</span> ${WORK_CODES.find(([c])=>c===r.other_code)?.[1]||''}` : '--'}</td>
      <td style="background:#F0FDF4;white-space:nowrap">${r.other_start ? r.other_start.slice(0,5)+'〜'+(r.other_end||'').slice(0,5) : '--'}</td>
      <td style="white-space:nowrap">
        <button class="btn-outline btn-sm" onclick="openReportModal(${r.id})">編集</button>
        <button class="btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger);margin-left:4px" onclick="deleteReportEntry(${r.id})">削除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tfoot.innerHTML = `<tr style="font-weight:700;background:#F8FAFC">
    <td colspan="3" style="text-align:right;padding:8px 12px">合計時間</td>
    <td style="background:#EFF6FF;padding:8px 12px">${fmtMin(totalBoard)}</td>
    <td></td>
    <td style="background:#ECFDF5;padding:8px 12px">${fmtMin(totalOther)}</td>
    <td></td>
  </tr>`;
}

function openReportModal(entryId = null) {
  document.getElementById('report-modal-title').textContent = entryId ? '日報 編集' : '日報 行追加';
  document.getElementById('rep-entry-id').value = entryId || '';
  if (entryId) {
    const r = reportEntries.find(e => e.id === entryId);
    if (!r) return;
    document.getElementById('rep-date').value = r.report_date;
    document.getElementById('rep-part').value = r.part_number || '';
    document.getElementById('rep-est').value = r.estimate_no || '';
    document.getElementById('rep-work-code').value = r.work_code || '';
    document.getElementById('rep-board-start').value = r.board_start ? r.board_start.slice(0,5) : '';
    document.getElementById('rep-board-end').value = r.board_end ? r.board_end.slice(0,5) : '';
    document.getElementById('rep-other-code').value = r.other_code || '';
    document.getElementById('rep-other-start').value = r.other_start ? r.other_start.slice(0,5) : '';
    document.getElementById('rep-other-end').value = r.other_end ? r.other_end.slice(0,5) : '';
  } else {
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('rep-date').value = today;
    document.getElementById('rep-part').value = '';
    document.getElementById('rep-est').value = '';
    document.getElementById('rep-work-code').value = '';
    document.getElementById('rep-board-start').value = '';
    document.getElementById('rep-board-end').value = '';
    document.getElementById('rep-other-code').value = '';
    document.getElementById('rep-other-start').value = '';
    document.getElementById('rep-other-end').value = '';
  }
  document.getElementById('report-modal').classList.remove('hidden');
}

function closeReportModal() {
  document.getElementById('report-modal').classList.add('hidden');
}

async function saveReport() {
  const entryId = document.getElementById('rep-entry-id').value;
  const date = document.getElementById('rep-date').value;
  if (!date) { alert('日付を入力してください'); return; }
  const body = {
    report_date: date,
    part_number: document.getElementById('rep-part').value.trim() || null,
    estimate_no: document.getElementById('rep-est').value.trim() || null,
    work_code: document.getElementById('rep-work-code').value || null,
    board_start: document.getElementById('rep-board-start').value || null,
    board_end: document.getElementById('rep-board-end').value || null,
    other_code: document.getElementById('rep-other-code').value || null,
    other_start: document.getElementById('rep-other-start').value || null,
    other_end: document.getElementById('rep-other-end').value || null,
  };
  try {
    const method = entryId ? 'PUT' : 'POST';
    const path = entryId ? `/api/reports/${entryId}` : '/api/reports';
    const res = await api(path, method, body);
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); return; }
    closeReportModal();
    loadReport();
  } catch(e) { alert('通信エラーが発生しました'); }
}

async function deleteReportEntry(entryId) {
  if (!confirm('この行を削除しますか？')) return;
  try {
    const res = await api(`/api/reports/${entryId}`, 'DELETE');
    if (!res.ok) { const d = await res.json(); alert(d.detail || 'エラー'); return; }
    loadReport();
  } catch(e) { alert('通信エラーが発生しました'); }
}

// ── 営業報告 ──
(function initSaleSelects() {
  const now = new Date();
  const ysel = document.getElementById('sale-year');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (y === now.getFullYear()) o.selected = true;
    ysel.appendChild(o);
  }
  const msel = document.getElementById('sale-month');
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + '月';
    if (m === now.getMonth() + 1) o.selected = true;
    msel.appendChild(o);
  }
})();

let salesEntries = [];

async function loadSales() {
  const year = document.getElementById('sale-year').value;
  const month = document.getElementById('sale-month').value;
  try {
    const res = await api(`/api/sales/mine?year=${year}&month=${month}`);
    const d = await res.json();
    if (!res.ok) return;
    salesEntries = d.entries || [];
    renderSales();
  } catch(e) {}
}

function renderSales() {
  const list = document.getElementById('sales-list');
  if (!salesEntries.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px">記録がありません</div>';
    return;
  }
  const statusColor = { '商談中':'#3B82F6','提案済':'#8B5CF6','受注':'#10B981','失注':'#EF4444','保留':'#F59E0B' };
  list.innerHTML = salesEntries.map(r => `
    <div style="background:#F8FAFC;border-radius:10px;padding:14px;margin-bottom:10px;border-left:4px solid ${statusColor[r.status]||'#94A3B8'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div>
          <span style="font-weight:800;font-size:1rem">${r.client_company}</span>
          ${r.client_dept ? `<span style="font-size:0.78rem;color:var(--text-muted);margin-left:6px">${r.client_dept}</span>` : ''}
          ${r.client_name ? `<span style="font-size:0.82rem;margin-left:6px">/ ${r.client_name}</span>` : ''}
        </div>
        <span style="font-size:0.75rem;font-weight:700;padding:2px 10px;border-radius:20px;background:${statusColor[r.status]||'#94A3B8'}22;color:${statusColor[r.status]||'#94A3B8'}">${r.status||''}</span>
      </div>
      <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px">${r.report_date}${r.purpose ? ' ｜ ' + r.purpose : ''}</div>
      ${r.content ? `<div style="font-size:0.85rem;margin-bottom:6px;white-space:pre-wrap">${r.content}</div>` : ''}
      <div style="display:flex;gap:16px;font-size:0.8rem;flex-wrap:wrap">
        ${r.amount ? `<span>💰 ${Number(r.amount).toLocaleString()}円</span>` : ''}
        ${r.next_action ? `<span>📌 ${r.next_action}</span>` : ''}
        ${r.next_date ? `<span>📅 ${r.next_date}</span>` : ''}
      </div>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="btn-outline btn-sm" onclick="openSalesModal(${r.id})">編集</button>
        <button class="btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="deleteSales(${r.id})">削除</button>
      </div>
    </div>
  `).join('');
}

function openSalesModal(entryId = null) {
  document.getElementById('sales-modal-title').textContent = entryId ? '営業報告 編集' : '営業報告 入力';
  document.getElementById('sale-entry-id').value = entryId || '';
  if (entryId) {
    const r = salesEntries.find(e => e.id === entryId);
    if (!r) return;
    document.getElementById('sale-date').value = r.report_date;
    document.getElementById('sale-company').value = r.client_company || '';
    document.getElementById('sale-dept').value = r.client_dept || '';
    document.getElementById('sale-person').value = r.client_name || '';
    document.getElementById('sale-purpose').value = r.purpose || '';
    document.getElementById('sale-content').value = r.content || '';
    document.getElementById('sale-amount').value = r.amount || '';
    document.getElementById('sale-status').value = r.status || '商談中';
    document.getElementById('sale-next-action').value = r.next_action || '';
    document.getElementById('sale-next-date').value = r.next_date || '';
  } else {
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('sale-date').value = today;
    document.getElementById('sale-company').value = '';
    document.getElementById('sale-dept').value = '';
    document.getElementById('sale-person').value = '';
    document.getElementById('sale-purpose').value = '';
    document.getElementById('sale-content').value = '';
    document.getElementById('sale-amount').value = '';
    document.getElementById('sale-status').value = '商談中';
    document.getElementById('sale-next-action').value = '';
    document.getElementById('sale-next-date').value = '';
  }
  document.getElementById('sales-modal').classList.remove('hidden');
}

function closeSalesModal() {
  document.getElementById('sales-modal').classList.add('hidden');
}

async function saveSales() {
  const entryId = document.getElementById('sale-entry-id').value;
  const date = document.getElementById('sale-date').value;
  const company = document.getElementById('sale-company').value.trim();
  if (!date) { alert('日付を入力してください'); return; }
  if (!company) { alert('会社名を入力してください'); return; }
  const body = {
    report_date: date,
    client_company: company,
    client_dept: document.getElementById('sale-dept').value.trim() || null,
    client_name: document.getElementById('sale-person').value.trim() || null,
    purpose: document.getElementById('sale-purpose').value.trim() || null,
    content: document.getElementById('sale-content').value.trim() || null,
    amount: document.getElementById('sale-amount').value ? parseInt(document.getElementById('sale-amount').value) : null,
    status: document.getElementById('sale-status').value || null,
    next_action: document.getElementById('sale-next-action').value.trim() || null,
    next_date: document.getElementById('sale-next-date').value || null,
  };
  try {
    const method = entryId ? 'PUT' : 'POST';
    const path = entryId ? `/api/sales/${entryId}` : '/api/sales';
    const res = await api(path, method, body);
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); return; }
    closeSalesModal();
    loadSales();
  } catch(e) { alert('通信エラーが発生しました'); }
}

async function deleteSales(entryId) {
  if (!confirm('この営業報告を削除しますか？')) return;
  try {
    const res = await api(`/api/sales/${entryId}`, 'DELETE');
    if (!res.ok) { const d = await res.json(); alert(d.detail || 'エラー'); return; }
    loadSales();
  } catch(e) { alert('通信エラーが発生しました'); }
}

// ── 残業申請 ──
(function initOtSelects() {
  const now = new Date();
  const ysel = document.getElementById('ot-year');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (y === now.getFullYear()) o.selected = true;
    ysel.appendChild(o);
  }
  const msel = document.getElementById('ot-month');
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + '月';
    if (m === now.getMonth() + 1) o.selected = true;
    msel.appendChild(o);
  }
})();

let overtimeEntries = [];

async function loadOvertime() {
  const year = document.getElementById('ot-year').value;
  const month = document.getElementById('ot-month').value;
  try {
    const res = await api(`/api/overtime/mine?year=${year}&month=${month}`);
    const d = await res.json();
    if (!res.ok) return;
    overtimeEntries = d.entries || [];
    renderOvertime();
  } catch(e) {}
}

function renderOvertime() {
  const list = document.getElementById('overtime-list');
  if (!overtimeEntries.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px">申請がありません</div>';
    return;
  }
  const statusColor = { pending:'#F59E0B', approved:'#10B981', rejected:'#EF4444' };
  const statusLabel = { pending:'申請中', approved:'承認済', rejected:'却下' };
  list.innerHTML = overtimeEntries.map(r => `
    <div style="background:#F8FAFC;border-radius:10px;padding:14px;margin-bottom:10px;border-left:4px solid ${statusColor[r.status]||'#94A3B8'}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-weight:800">${r.work_date}</span>
        <span style="font-size:0.75rem;font-weight:700;padding:2px 10px;border-radius:20px;background:${statusColor[r.status]||'#94A3B8'}22;color:${statusColor[r.status]||'#94A3B8'}">${statusLabel[r.status]||r.status}</span>
      </div>
      <div style="font-size:0.83rem;display:flex;gap:16px;flex-wrap:wrap;margin-bottom:4px">
        ${r.planned_end ? `<span>予定終了: <strong>${r.planned_end.slice(0,5)}</strong></span>` : ''}
        ${r.clock_out ? `<span>実際退勤: <strong>${r.clock_out.slice(0,5)}</strong></span>` : ''}
        ${r.overtime_minutes != null ? `<span>残業: <strong>${Math.floor(r.overtime_minutes/60)}h${r.overtime_minutes%60?r.overtime_minutes%60+'m':''}</strong></span>` : ''}
      </div>
      ${r.reason ? `<div style="font-size:0.83rem;color:var(--text-muted)">${r.reason}</div>` : ''}
    </div>
  `).join('');
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
