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

    const extBtns = document.getElementById('external-buttons');
    if (!d.clock_in) {
      status.textContent = _t('status_not_working');
      btnIn.disabled = false; btnOut.disabled = true;
      extBtns.style.display = 'none';
    } else if (!d.clock_out) {
      status.textContent = _t('status_working');
      btnIn.disabled = true; btnOut.disabled = false;
      extBtns.style.display = 'flex';
      document.getElementById('btn-go-out').disabled = false;
      await loadExternalStatus();
    } else {
      status.textContent = _t('status_done');
      btnIn.disabled = true; btnOut.disabled = true;
      extBtns.style.display = 'none';
    }
  } catch(e) {
    document.getElementById('clock-status').textContent = _t('status_error');
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
  document.getElementById('clock-status').textContent = trip ? _t('status_trip') : _t('status_loading');
  if (trip) loadTodayStatus();
}

// ── 外出・帰社 ──
async function loadExternalStatus() {
  try {
    const res = await api('/api/attendance/external/today');
    const d = await res.json();
    updateExternalUI(d.currently_out, d.records || []);
  } catch(e) {}
}

function updateExternalUI(currentlyOut, records) {
  const btnOut = document.getElementById('btn-go-out');
  const btnRet = document.getElementById('btn-return');
  const log    = document.getElementById('external-log');

  if (currentlyOut) {
    btnOut.style.display = 'none';
    btnRet.style.display = 'inline-block';
    btnRet.disabled = false;
  } else {
    btnOut.style.display = 'inline-block';
    btnRet.style.display = 'none';
  }

  if (records.length) {
    log.innerHTML = records.map(r =>
      `🚗 ${r.out_time.slice(0,5)}${r.in_time ? ' → 🏢 ' + r.in_time.slice(0,5) : ' （外出中）'}${r.note ? ' ' + r.note : ''}`
    ).join('　');
  }
}

async function goOut() {
  const note = prompt('外出理由（任意）', '') ;
  if (note === null) return; // キャンセル
  try {
    const res = await api('/api/attendance/go-out', 'POST', { note: note || null });
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラー'); return; }
    document.getElementById('clock-status').textContent = _t('status_out');
    await loadExternalStatus();
  } catch(e) { alert(_t('alert_comm_error')); }
}

async function returnFromOut() {
  try {
    const res = await api('/api/attendance/return', 'POST');
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラー'); return; }
    document.getElementById('clock-status').textContent = _t('status_working');
    await loadExternalStatus();
  } catch(e) { alert(_t('alert_comm_error')); }
}

// ── 出勤 ──
async function clockIn() {
  const btn = document.getElementById('btn-in');
  btn.disabled = true; btn.textContent = _t('btn_getting');
  const trip = isTrip();
  const pos = trip ? null : await getGPS();
  try {
    const body = { location_type: trip ? 'business_trip' : 'office' };
    if (pos) { body.lat = pos.lat; body.lon = pos.lon; }
    const res = await api('/api/attendance/clock-in', 'POST', body);
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); btn.disabled = false; btn.textContent = _t('btn_clock_in'); return; }
    await loadTodayStatus();
  } catch(e) { alert(_t('alert_comm_error')); btn.disabled = false; btn.textContent = _t('btn_clock_in'); }
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
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); btn.disabled = false; btn.textContent = _t('btn_clock_out'); return; }
    await loadTodayStatus();
  } catch(e) { alert(_t('alert_comm_error')); btn.disabled = false; btn.textContent = _t('btn_clock_out'); }
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
    const records = d.records || [];
    const totalOt = d.total_overtime_minutes || 0;
    let totalWork = 0;
    records.forEach(r => { totalWork += r.work_minutes || 0; });

    // 残業累計の警告レベル
    const otH = totalOt / 60;
    const otColor = otH >= 80 ? 'var(--danger)' : otH >= 45 ? 'var(--warning)' : 'inherit';
    const otWarn  = otH >= 80 ? _t('warn_80h') : otH >= 45 ? _t('warn_45h') : '';

    records.forEach(r => {
      const tr = document.createElement('tr');
      const lateBadge  = r.is_late  ? `<span style="background:#FEE2E2;color:#DC2626;font-size:0.68rem;padding:1px 5px;border-radius:4px;margin-left:3px">${_t('badge_late')}</span>` : '';
      const earlyBadge = r.is_early ? `<span style="background:#FEF9C3;color:#B45309;font-size:0.68rem;padding:1px 5px;border-radius:4px;margin-left:3px">${_t('badge_early')}</span>` : '';
      tr.innerHTML = `
        <td>${r.date.slice(5).replace('-','/')}</td>
        <td>${r.clock_in ? r.clock_in.slice(0,5) : '--'}${lateBadge}</td>
        <td>${r.clock_out ? r.clock_out.slice(0,5) : '--'}${earlyBadge}</td>
        <td>${r.work_minutes != null ? fmtMin(r.work_minutes) : '--'}</td>
        <td style="color:var(--warning)">${r.overtime_minutes ? fmtMin(r.overtime_minutes) : '--'}</td>
      `;
      tbody.appendChild(tr);
    });
    document.getElementById('sum-work').textContent = fmtMin(totalWork);
    const sumOtEl = document.getElementById('sum-ot');
    sumOtEl.textContent = fmtMin(totalOt) + otWarn;
    sumOtEl.style.color = otColor;

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
    if (!d2.requests?.length) el.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem">${_t('no_history')}</div>`;
  } catch(e) {}
}

async function submitLeave() {
  const start = document.getElementById('leave-start').value;
  const end = document.getElementById('leave-end').value;
  const days = document.getElementById('leave-days').value;
  const reason = document.getElementById('leave-reason').value;
  if (!start || !end || !days) { alert(_t('alert_leave_input')); return; }
  try {
    const res = await api('/api/leave/request', 'POST', { start_date: start, end_date: end, days: parseFloat(days), reason });
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); return; }
    alert(_t('alert_applied'));
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
const TAB_NAMES = ['history','shift','leave','report','sales','overtime','correction'];

function showTab(name) {
  TAB_NAMES.forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = (t === name) ? '' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const m = btn.getAttribute('onclick')?.match(/showTab\('(\w+)'\)/);
    if (m) btn.classList.toggle('active', m[1] === name);
  });
  if (name === 'shift') setShiftView(shiftViewMode);
  if (name === 'leave') loadLeaveInfo();
  if (name === 'report') loadReport();
  if (name === 'sales') loadSales();
  if (name === 'overtime') loadOvertime();
  if (name === 'correction') loadCorrectionHistory();
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
let currentShiftData = [];
let shiftViewMode = 'weekly';

// ── シフト表示モード切替 ──
function setShiftView(mode) {
  shiftViewMode = mode;
  const btnWeek  = document.getElementById('shift-btn-week');
  const btnMonth = document.getElementById('shift-btn-month');
  const ctrl     = document.getElementById('shift-monthly-ctrl');
  const primary  = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#1E40AF';
  btnWeek.style.background  = mode === 'weekly'  ? 'var(--primary)' : 'white';
  btnWeek.style.color       = mode === 'weekly'  ? 'white' : 'var(--text-muted)';
  btnMonth.style.background = mode === 'monthly' ? 'var(--primary)' : 'white';
  btnMonth.style.color      = mode === 'monthly' ? 'white' : 'var(--text-muted)';
  ctrl.style.display = mode === 'monthly' ? 'flex' : 'none';
  if (mode === 'weekly') loadWeeklyShifts();
  else loadShiftTable();
}

// ── 今日から7日間シフト ──
async function loadWeeklyShifts() {
  const status = document.getElementById('shift-status');
  status.textContent = _t('status_loading');
  document.getElementById('shift-emp-thead').innerHTML = '';
  document.getElementById('shift-emp-tbody').innerHTML = '';

  const today = new Date();
  const dates = Array.from({length: 7}, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    return d;
  });

  // 必要な年月を取得（週が月をまたぐ場合2ヶ月）
  const ymSet = new Set(dates.map(d => `${d.getFullYear()}_${d.getMonth() + 1}`));
  const allShifts = [];
  try {
    for (const ym of ymSet) {
      const [y, m] = ym.split('_');
      const res = await api(`/api/shifts?year=${y}&month=${m}`);
      const d = await res.json();
      if (res.ok) allShifts.push(...(d.shifts || []));
    }
    status.textContent = '';
    currentShiftData = allShifts;
    renderWeeklyShiftTable(allShifts, dates);
  } catch(e) {
    status.textContent = _t('alert_comm_error');
  }
}

function renderWeeklyShiftTable(shifts, dates) {
  const thead  = document.getElementById('shift-emp-thead');
  const tbody  = document.getElementById('shift-emp-tbody');
  const DOW    = _t('dow');
  const todayStr = new Date().toISOString().slice(0, 10);
  const dateStrs = dates.map(d => d.toISOString().slice(0, 10));

  // ヘッダー
  let headHtml = `<tr><th style="position:sticky;left:0;background:#F8FAFC;z-index:1;padding:6px 10px;border:1px solid #E2E8F0;white-space:nowrap">${_t('col_name')}</th>`;
  dates.forEach(dt => {
    const ds  = dt.toISOString().slice(0, 10);
    const dow = dt.getDay();
    const isToday = ds === todayStr;
    const tc  = dow === 0 ? '#EF4444' : dow === 6 ? '#3B82F6' : 'var(--text)';
    const bg  = isToday ? 'background:#DBEAFE;' : '';
    headHtml += `<th style="min-width:62px;text-align:center;padding:4px 2px;border:1px solid #E2E8F0;${bg}color:${tc}">
      ${dt.getMonth()+1}/${dt.getDate()}<br>
      <span style="font-size:0.68rem">${DOW[dow]}</span>
      ${isToday ? `<br><span style="font-size:0.6rem;background:var(--primary);color:white;border-radius:3px;padding:0 3px">${_t('today_label')}</span>` : ''}
    </th>`;
  });
  headHtml += '</tr>';
  thead.innerHTML = headHtml;

  // 従業員マップ
  const empMap = {};
  shifts.filter(s => dateStrs.includes(s.shift_date)).forEach(s => {
    if (!empMap[s.employee_id]) empMap[s.employee_id] = { name: s.name, department: s.department || '', dates: {} };
    empMap[s.employee_id].dates[s.shift_date] = { start: s.start_time, end: s.end_time };
  });

  if (!Object.keys(empMap).length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#94A3B8;padding:24px">${_t('shift_no_data')}</td></tr>`;
    return;
  }

  let bodyHtml = '';
  Object.entries(empMap).forEach(([empId, emp]) => {
    const isMe = empId === myEmployeeId;
    const rowBg = isMe ? '#EFF6FF' : '';
    bodyHtml += `<tr style="background:${rowBg}">`;
    bodyHtml += `<td style="position:sticky;left:0;background:${isMe ? '#EFF6FF' : '#F8FAFC'};z-index:1;white-space:nowrap;padding:6px 10px;border:1px solid #E2E8F0;font-weight:${isMe ? '700' : '400'}">${emp.name}${isMe ? ' 👤' : ''}</td>`;
    dateStrs.forEach(ds => {
      const shift = emp.dates[ds];
      const dow   = new Date(ds).getDay();
      const bgBase = dow === 0 ? '#FFF8F8' : dow === 6 ? '#F0F5FF' : ds === todayStr ? '#F0F9FF' : 'white';
      if (shift) {
        bodyHtml += `<td style="text-align:center;padding:4px 2px;border:1px solid #E2E8F0;font-size:0.72rem;white-space:nowrap;background:${isMe ? '#DBEAFE' : '#F0FDF4'};color:${isMe ? '#1D4ED8' : '#065F46'}"><strong>${shift.start.slice(0,5)}</strong><br>${shift.end.slice(0,5)}</td>`;
      } else {
        bodyHtml += `<td style="border:1px solid #E2E8F0;background:${bgBase}"></td>`;
      }
    });
    bodyHtml += '</tr>';
  });
  tbody.innerHTML = bodyHtml;
}

async function loadShiftTable() {
  const year = document.getElementById('shift-emp-year').value;
  const month = document.getElementById('shift-emp-month').value;
  const status = document.getElementById('shift-status');
  status.textContent = _t('status_loading');
  document.getElementById('shift-emp-thead').innerHTML = '';
  document.getElementById('shift-emp-tbody').innerHTML = '';
  try {
    const res = await api(`/api/shifts?year=${year}&month=${month}`);
    const d = await res.json();
    if (!res.ok) { status.textContent = _t('alert_comm_error'); return; }
    status.textContent = '';
    currentShiftData = d.shifts || [];
    renderShiftTable(currentShiftData, parseInt(year), parseInt(month));
  } catch(e) {
    status.textContent = _t('alert_comm_error');
  }
}

function exportShiftExcel() {
  if (!currentShiftData.length) { alert(_t('alert_no_shift')); return; }
  const year = parseInt(document.getElementById('shift-emp-year').value);
  const month = parseInt(document.getElementById('shift-emp-month').value);
  const daysInMonth = new Date(year, month, 0).getDate();
  const DOW = _t('dow');

  const header = [_t('col_name'), _t('col_dept')];
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    header.push(`${d}(${DOW[dt.getDay()]})`);
  }

  const empMap = {};
  currentShiftData.forEach(s => {
    if (!empMap[s.employee_id]) empMap[s.employee_id] = { name: s.name, department: s.department || '', dates: {} };
    empMap[s.employee_id].dates[s.shift_date] = `${s.start_time.slice(0,5)}~${s.end_time.slice(0,5)}`;
  });

  const rows = [header];
  Object.values(empMap).forEach(emp => {
    const row = [emp.name, emp.department];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      row.push(emp.dates[dateStr] || '');
    }
    rows.push(row);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  // 列幅設定
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, ...Array(daysInMonth).fill({ wch: 9 })];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `${year}年${month}月`);
  XLSX.writeFile(wb, `シフト表_${year}年${month}月.xlsx`);
}

function renderShiftTable(shifts, year, month) {
  const thead = document.getElementById('shift-emp-thead');
  const tbody = document.getElementById('shift-emp-tbody');

  const daysInMonth = new Date(year, month, 0).getDate();
  const DOW = _t('dow');

  // 日付ヘッダー
  let headHtml = `<tr><th style="position:sticky;left:0;background:#F8FAFC;z-index:1;white-space:nowrap;padding:6px 10px;border:1px solid #E2E8F0">${_t('col_name')}</th>`;
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
    tbody.innerHTML = `<tr><td colspan="${daysInMonth + 1}" style="text-align:center;color:#94A3B8;padding:20px">${_t('shift_no_data')}</td></tr>`;
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


// ── 打刻修正申請 ──
async function submitCorrection() {
  const date   = document.getElementById('corr-date').value;
  const inTime = document.getElementById('corr-in').value;
  const outTime= document.getElementById('corr-out').value;
  const reason = document.getElementById('corr-reason').value;
  if (!date) { alert('対象日を選択してください'); return; }
  if (!inTime && !outTime) { alert('修正後の時刻を少なくとも一方入力してください'); return; }
  try {
    const res = await api('/api/corrections/request', 'POST', {
      work_date: date,
      requested_clock_in:  inTime  ? inTime  + ':00' : null,
      requested_clock_out: outTime ? outTime + ':00' : null,
      reason: reason || null,
    });
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラー'); return; }
    alert('申請しました。管理者が確認次第、承認されます。');
    document.getElementById('corr-date').value = '';
    document.getElementById('corr-in').value = '';
    document.getElementById('corr-out').value = '';
    document.getElementById('corr-reason').value = '';
    loadCorrectionHistory();
  } catch(e) { alert('通信エラー'); }
}

async function loadCorrectionHistory() {
  try {
    const res = await api('/api/corrections/mine');
    const d = await res.json();
    const el = document.getElementById('correction-history');
    const reqs = d.requests || [];
    if (!reqs.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">申請履歴はありません</div>'; return; }
    const sc = { pending:'#F59E0B', approved:'#10B981', rejected:'#EF4444' };
    const sl = { pending:'申請中', approved:'承認済', rejected:'却下' };
    el.innerHTML = reqs.map(r => `
      <div style="background:#F8FAFC;border-radius:10px;padding:12px 14px;margin-bottom:8px;font-size:0.85rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <strong>${r.work_date}</strong>
          <span style="font-size:0.75rem;font-weight:700;padding:2px 10px;border-radius:20px;background:${sc[r.status]}22;color:${sc[r.status]}">${sl[r.status]||r.status}</span>
        </div>
        <div style="color:var(--text-muted)">
          出勤: ${r.requested_clock_in ? r.requested_clock_in.slice(0,5) : '--'} ／
          退勤: ${r.requested_clock_out ? r.requested_clock_out.slice(0,5) : '--'}
        </div>
        ${r.reason ? `<div style="color:var(--text-muted);margin-top:3px">理由: ${r.reason}</div>` : ''}
      </div>
    `).join('');
  } catch(e) {}
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
  return _statusLabel(s);  // i18n.js の _statusLabel を使用
}

/* 言語切替後に動的テキストを再描画するフック */
function _refreshDynamicText() {
  // 表示中のステータスを再描画（i18n.jsから呼ばれる）
  loadTodayStatus();
  loadExternalStatus().catch(() => {});
}

function statusBadge(s) {
  return { pending:'badge-yellow', approved:'badge-green', rejected:'badge-red' }[s] || 'badge-gray';
}
