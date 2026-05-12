const token = localStorage.getItem('token');
const role = localStorage.getItem('role');
const name = localStorage.getItem('name');
if (!token || role === 'employee') { localStorage.clear(); location.href = '/'; }

document.getElementById('user-name').textContent = name || '';

let allAttendance = [];
let allLeave = [];
let allTrips = [];
let editingEmpId = null;
let currentPin = null;

function genPin() {
  return String(Math.floor(Math.random() * 900) + 100);
}

function regenPin() {
  currentPin = genPin();
  document.getElementById('pin-value').textContent = currentPin;
}

function resetPin() {
  const newPin = genPin();
  document.getElementById('pin-reset-value').textContent = newPin;
  currentPin = newPin;
}

// ── セクション切り替え ──
function showSection(sec) {
  ['dashboard','employees','attendance','leave','trip','shifts','settings'].forEach(s => {
    document.getElementById('section-' + s).classList.toggle('hidden', s !== sec);
    document.getElementById('nav-' + s).classList.toggle('active', s === sec);
  });
  if (sec === 'dashboard') loadDashboard();
  if (sec === 'employees') loadEmployees();
  if (sec === 'attendance') loadAttendance();
  if (sec === 'leave') loadLeave('pending');
  if (sec === 'trip') loadTrip('pending');
  if (sec === 'shifts') initShifts();
  if (sec === 'settings') loadSettings();
}

// ── ダッシュボード ──
async function loadDashboard() {
  try {
    const [statsRes, todayRes] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/today')
    ]);
    const stats = await statsRes.json();
    const today = await todayRes.json();

    const grid = document.getElementById('stats-grid');
    grid.innerHTML = `
      <div class="stat-card"><div class="stat-label">総従業員数</div><div class="stat-value">${stats.total_employees || 0}<span class="stat-unit"> 名</span></div></div>
      <div class="stat-card"><div class="stat-label">本日出勤</div><div class="stat-value" style="color:var(--accent)">${stats.today_present || 0}<span class="stat-unit"> 名</span></div></div>
      <div class="stat-card"><div class="stat-label">有給申請中</div><div class="stat-value" style="color:var(--warning)">${stats.pending_leave || 0}<span class="stat-unit"> 件</span></div></div>
      <div class="stat-card"><div class="stat-label">出張申請中</div><div class="stat-value" style="color:var(--primary-light)">${stats.pending_trip || 0}<span class="stat-unit"> 件</span></div></div>
    `;

    const tbody = document.getElementById('today-body');
    tbody.innerHTML = '';
    (today.records || []).forEach(r => {
      const tr = document.createElement('tr');
      const statusHtml = r.clock_out
        ? '<span class="badge badge-gray">退勤済</span>'
        : r.clock_in
          ? '<span class="badge badge-green">出勤中</span>'
          : '<span class="badge badge-red">未出勤</span>';
      tr.innerHTML = `
        <td>${r.name}</td>
        <td>${r.department || '--'}</td>
        <td>${r.clock_in ? r.clock_in.slice(0,5) : '--'}</td>
        <td>${r.clock_out ? r.clock_out.slice(0,5) : '--'}</td>
        <td>${statusHtml}</td>
      `;
      tbody.appendChild(tr);
    });
    if (!today.records?.length) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
  } catch(e) {}
}

// ── 従業員管理 ──
async function loadEmployees() {
  try {
    const res = await api('/api/admin/employees');
    const d = await res.json();
    const tbody = document.getElementById('emp-body');
    tbody.innerHTML = '';
    (d.employees || []).forEach(e => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${e.employee_id}</td>
        <td>${e.name}</td>
        <td>${e.department || '--'}</td>
        <td>${e.position || '--'}</td>
        <td>${e.leave_remaining} 日</td>
        <td>
          <button class="btn-outline btn-sm" onclick="openEmpModal('${e.employee_id}')">編集</button>
          <button class="btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger);margin-left:4px" onclick="deleteEmployee('${e.employee_id}','${e.name}')">削除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch(e) {}
}

async function openEmpModal(empId = null) {
  editingEmpId = empId;
  currentPin = null;
  document.getElementById('emp-modal-title').textContent = empId ? '従業員編集' : '従業員登録';
  document.getElementById('m-emp-id').value = '';
  document.getElementById('m-emp-name').value = '';
  document.getElementById('m-emp-role').value = '';
  document.getElementById('m-emp-perm').value = 'employee';
  document.getElementById('m-emp-leave').value = '10';
  document.getElementById('pin-reset-value').textContent = '';

  await loadDeptOptions('m-emp-dept');

  if (empId) {
    document.getElementById('m-emp-id').disabled = true;
    document.getElementById('pin-display').classList.add('hidden');
    document.getElementById('pin-reset').classList.remove('hidden');
    try {
      const res = await api('/api/admin/employees/' + empId);
      const e = await res.json();
      document.getElementById('m-emp-id').value = e.employee_id;
      document.getElementById('m-emp-name').value = e.name;
      document.getElementById('m-emp-role').value = e.position || '';
      document.getElementById('m-emp-perm').value = e.role;
      document.getElementById('m-emp-leave').value = e.leave_remaining;
      document.getElementById('m-emp-dept').value = e.department_id || '';
    } catch(e) {}
  } else {
    document.getElementById('m-emp-id').disabled = false;
    document.getElementById('pin-display').classList.remove('hidden');
    document.getElementById('pin-reset').classList.add('hidden');
    regenPin();
  }
  document.getElementById('emp-modal').classList.remove('hidden');
}

function closeEmpModal() {
  document.getElementById('emp-modal').classList.add('hidden');
  editingEmpId = null;
}

async function saveEmployee() {
  const empId = document.getElementById('m-emp-id').value.trim();
  const name = document.getElementById('m-emp-name').value.trim();
  if (!name) { alert('氏名を入力してください'); return; }

  if (!editingEmpId) {
    if (!/^\d{3}$/.test(empId)) { alert('社員IDは3桁の数字で入力してください（例: 001）'); return; }
    if (!currentPin) { alert('PINが生成されていません'); return; }
  }

  const body = {
    employee_id: empId,
    name,
    password: currentPin || undefined,
    department_id: document.getElementById('m-emp-dept').value ? parseInt(document.getElementById('m-emp-dept').value) : null,
    position: document.getElementById('m-emp-role').value.trim(),
    role: document.getElementById('m-emp-perm').value,
    leave_remaining: parseFloat(document.getElementById('m-emp-leave').value) || 10
  };
  try {
    const method = editingEmpId ? 'PUT' : 'POST';
    const path = editingEmpId ? '/api/admin/employees/' + editingEmpId : '/api/admin/employees';
    const res = await api(path, method, body);
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); return; }
    if (!editingEmpId) {
      alert(`登録完了！\n社員ID: ${empId}\nPIN: ${currentPin}\n\n従業員に伝えてください。`);
    }
    closeEmpModal();
    loadEmployees();
  } catch(e) { alert('通信エラーが発生しました'); }
}

async function deleteEmployee(empId, empName) {
  if (!confirm(`${empName} を削除しますか？`)) return;
  try {
    const res = await api('/api/admin/employees/' + empId, 'DELETE');
    if (!res.ok) { const d = await res.json(); alert(d.detail || 'エラー'); return; }
    loadEmployees();
  } catch(e) { alert('通信エラー'); }
}

// ── 勤怠一覧 ──
(function initAttSelects() {
  const now = new Date();
  const ysel = document.getElementById('att-year');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (y === now.getFullYear()) o.selected = true;
    ysel.appendChild(o);
  }
  const msel = document.getElementById('att-month');
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + '月';
    if (m === now.getMonth() + 1) o.selected = true;
    msel.appendChild(o);
  }
})();

async function loadAttendance() {
  const year = document.getElementById('att-year').value;
  const month = document.getElementById('att-month').value;
  const dept = document.getElementById('att-dept').value;
  try {
    let url = `/api/admin/attendance?year=${year}&month=${month}`;
    if (dept) url += `&department_id=${dept}`;
    const res = await api(url);
    const d = await res.json();
    allAttendance = d.records || [];
    renderAttendance();
  } catch(e) {}
}

function renderAttendance() {
  const tbody = document.getElementById('att-body');
  tbody.innerHTML = '';
  allAttendance.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.date}</td>
      <td>${r.name}</td>
      <td>${r.department || '--'}</td>
      <td>${r.clock_in ? r.clock_in.slice(0,5) : '--'}</td>
      <td>${r.clock_out ? r.clock_out.slice(0,5) : '--'}</td>
      <td>${r.work_minutes != null ? fmtMin(r.work_minutes) : '--'}</td>
      <td style="color:var(--warning)">${r.overtime_minutes ? fmtMin(r.overtime_minutes) : '--'}</td>
    `;
    tbody.appendChild(tr);
  });
  if (!allAttendance.length) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
}

function exportCSV() {
  if (!allAttendance.length) { alert('データがありません'); return; }
  const headers = ['日付','氏名','部署','出勤','退勤','勤務時間','残業時間'];
  const rows = allAttendance.map(r => [
    r.date, r.name, r.department || '',
    r.clock_in ? r.clock_in.slice(0,5) : '',
    r.clock_out ? r.clock_out.slice(0,5) : '',
    r.work_minutes != null ? fmtMin(r.work_minutes) : '',
    r.overtime_minutes ? fmtMin(r.overtime_minutes) : ''
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `勤怠_${document.getElementById('att-year').value}_${document.getElementById('att-month').value}.csv`;
  a.click();
}

// ── 有給申請管理 ──
async function loadLeave(filter = 'pending') {
  try {
    const res = await api('/api/admin/leave?status=' + (filter === 'all' ? '' : filter));
    const d = await res.json();
    allLeave = d.requests || [];
    renderLeave();
  } catch(e) {}
}

function filterLeave(f) {
  loadLeave(f);
}

function renderLeave() {
  const el = document.getElementById('leave-list');
  el.innerHTML = '';
  allLeave.forEach(r => {
    const div = document.createElement('div');
    div.style.cssText = 'padding:14px;border-radius:10px;background:#F8FAFC;margin-bottom:10px;border:1px solid var(--border)';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-weight:700">${r.name}</span>
          <span style="font-size:0.82rem;color:var(--text-muted);margin-left:8px">${r.department || ''}</span>
        </div>
        <span class="badge ${statusBadge(r.status)}">${statusLabel(r.status)}</span>
      </div>
      <div style="margin-top:8px;font-size:0.88rem">
        ${r.start_date} ～ ${r.end_date}（${r.days}日）
        ${r.reason ? `<span style="color:var(--text-muted)"> / ${r.reason}</span>` : ''}
      </div>
      ${r.status === 'pending' ? `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn-primary btn-accent" style="flex:1;padding:8px;font-size:0.88rem" onclick="approveLeave(${r.id})">承認</button>
          <button class="btn-primary btn-danger" style="flex:1;padding:8px;font-size:0.88rem" onclick="rejectLeave(${r.id})">却下</button>
        </div>
      ` : ''}
    `;
    el.appendChild(div);
  });
  if (!allLeave.length) el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">申請はありません</div>';
}

async function approveLeave(id) {
  try {
    const res = await api('/api/admin/leave/' + id + '/approve', 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    loadLeave('pending');
  } catch(e) { alert('通信エラー'); }
}

async function rejectLeave(id) {
  try {
    const res = await api('/api/admin/leave/' + id + '/reject', 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    loadLeave('pending');
  } catch(e) { alert('通信エラー'); }
}

// ── 出張申請管理 ──
async function loadTrip(filter = 'pending') {
  try {
    const res = await api('/api/admin/trips?status=' + (filter === 'all' ? '' : filter));
    const d = await res.json();
    allTrips = d.requests || [];
    renderTrip();
  } catch(e) {}
}

function filterTrip(f) {
  loadTrip(f);
}

function renderTrip() {
  const el = document.getElementById('trip-list');
  el.innerHTML = '';
  allTrips.forEach(r => {
    const div = document.createElement('div');
    div.style.cssText = 'padding:14px;border-radius:10px;background:#F8FAFC;margin-bottom:10px;border:1px solid var(--border)';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-weight:700">${r.name}</span>
          <span style="font-size:0.82rem;color:var(--text-muted);margin-left:8px">${r.department || ''}</span>
        </div>
        <span class="badge ${statusBadge(r.status)}">${statusLabel(r.status)}</span>
      </div>
      <div style="margin-top:8px;font-size:0.88rem">
        ${r.trip_date} / ${r.destination}
        ${r.reason ? `<span style="color:var(--text-muted)"> / ${r.reason}</span>` : ''}
      </div>
      ${r.status === 'pending' ? `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn-primary btn-accent" style="flex:1;padding:8px;font-size:0.88rem" onclick="approveTrip(${r.id})">承認</button>
          <button class="btn-primary btn-danger" style="flex:1;padding:8px;font-size:0.88rem" onclick="rejectTrip(${r.id})">却下</button>
        </div>
      ` : ''}
    `;
    el.appendChild(div);
  });
  if (!allTrips.length) el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">申請はありません</div>';
}

async function approveTrip(id) {
  try {
    const res = await api('/api/admin/trips/' + id + '/approve', 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    loadTrip('pending');
  } catch(e) { alert('通信エラー'); }
}

async function rejectTrip(id) {
  try {
    const res = await api('/api/admin/trips/' + id + '/reject', 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    loadTrip('pending');
  } catch(e) { alert('通信エラー'); }
}

// ── 設定 ──
async function loadSettings() {
  try {
    const [compRes, deptRes] = await Promise.all([
      api('/api/company/settings'),
      api('/api/departments')
    ]);
    const comp = await compRes.json();
    if (compRes.ok) {
      document.getElementById('set-company-name').value = comp.name || '';
      document.getElementById('set-lat').value = comp.office_lat || '';
      document.getElementById('set-lon').value = comp.office_lon || '';
      document.getElementById('set-radius').value = comp.gps_radius || 500;
      document.getElementById('set-work-hours').value = comp.work_hours_per_day || 8;
      document.getElementById('set-leave-days').value = comp.default_leave_days || 10;
    }
    const depts = await deptRes.json();
    await loadDeptOptions('att-dept', true);
    renderDeptList(depts.departments || []);
  } catch(e) {}
}

function renderDeptList(depts) {
  const el = document.getElementById('dept-list');
  el.innerHTML = '';
  depts.forEach(d => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#F8FAFC;border-radius:8px;margin-bottom:6px';
    div.innerHTML = `
      <span>${d.name}</span>
      <button class="btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="deleteDept(${d.id},'${d.name}')">削除</button>
    `;
    el.appendChild(div);
  });
  if (!depts.length) el.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">部署が登録されていません</div>';
}

async function saveCompanySettings() {
  const body = {
    name: document.getElementById('set-company-name').value.trim(),
    office_lat: parseFloat(document.getElementById('set-lat').value) || null,
    office_lon: parseFloat(document.getElementById('set-lon').value) || null,
    gps_radius: parseInt(document.getElementById('set-radius').value) || 500
  };
  try {
    const res = await api('/api/company/settings', 'PUT', body);
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    alert('設定を保存しました');
  } catch(e) { alert('通信エラー'); }
}

async function saveWorkSettings() {
  const body = {
    work_hours_per_day: parseFloat(document.getElementById('set-work-hours').value) || 8,
    default_leave_days: parseFloat(document.getElementById('set-leave-days').value) || 10
  };
  try {
    const res = await api('/api/company/work-settings', 'PUT', body);
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    alert('設定を保存しました');
  } catch(e) { alert('通信エラー'); }
}

async function addDept() {
  const name = document.getElementById('dept-name').value.trim();
  if (!name) { alert('部署名を入力してください'); return; }
  try {
    const res = await api('/api/departments', 'POST', { name });
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    document.getElementById('dept-name').value = '';
    const deptRes = await api('/api/departments');
    const d = await deptRes.json();
    renderDeptList(d.departments || []);
    await loadDeptOptions('att-dept', true);
    await loadDeptOptions('m-emp-dept');
  } catch(e) { alert('通信エラー'); }
}

async function deleteDept(id, name) {
  if (!confirm(`部署「${name}」を削除しますか？`)) return;
  try {
    const res = await api('/api/departments/' + id, 'DELETE');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    const deptRes = await api('/api/departments');
    const d = await deptRes.json();
    renderDeptList(d.departments || []);
    await loadDeptOptions('att-dept', true);
  } catch(e) { alert('通信エラー'); }
}

async function loadDeptOptions(selectId, withAll = false) {
  try {
    const res = await api('/api/departments');
    const d = await res.json();
    const sel = document.getElementById(selectId);
    const prevVal = sel.value;
    sel.innerHTML = withAll ? '<option value="">全部署</option>' : '<option value="">-- 選択 --</option>';
    (d.departments || []).forEach(dept => {
      const o = document.createElement('option');
      o.value = dept.id; o.textContent = dept.name;
      sel.appendChild(o);
    });
    sel.value = prevVal;
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
  return { pending:'申請中', approved:'承認済', rejected:'却下' }[s] || s;
}

function statusBadge(s) {
  return { pending:'badge-yellow', approved:'badge-green', rejected:'badge-red' }[s] || 'badge-gray';
}

// ── シフト管理 ──────────────────────────────────────────────────────────────

let shiftData = [];
let shiftTemplates = [];
let shiftEmployees = [];

(function initShiftSelects() {
  const now = new Date();
  const ysel = document.getElementById('shift-year');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 1; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (y === now.getFullYear()) o.selected = true;
    ysel.appendChild(o);
  }
  // 翌月まで
  for (let y = now.getFullYear(); y <= now.getFullYear() + 1; y++) {
    const opt = ysel.options[0];
    if (!opt || parseInt(opt.value) < y) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y + '年';
      ysel.appendChild(o);
    }
  }
  const msel = document.getElementById('shift-month');
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + '月';
    if (m === now.getMonth() + 1) o.selected = true;
    msel.appendChild(o);
  }
})();

async function initShifts() {
  await loadDeptOptions('shift-dept-filter', true);
  await Promise.all([loadTemplates(), loadShiftEmployees()]);
  loadShifts();
}

async function loadShiftEmployees() {
  try {
    const res = await api('/api/admin/employees');
    const d = await res.json();
    shiftEmployees = d.employees || [];
  } catch(e) {}
}

async function loadTemplates() {
  try {
    const res = await api('/api/admin/shift-templates');
    const d = await res.json();
    shiftTemplates = d.templates || [];
    renderTemplates();
  } catch(e) {}
}

function renderTemplates() {
  const el = document.getElementById('tmpl-list');
  el.innerHTML = '';
  shiftTemplates.forEach(t => {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:#EFF6FF;border-radius:20px;padding:4px 12px;font-size:0.82rem;cursor:pointer;border:1px solid var(--border)';
    chip.innerHTML = `<strong>${t.name}</strong> ${t.start_time}〜${t.end_time} <span onclick="deleteTemplate(${t.id})" style="color:var(--danger);font-weight:700;padding-left:4px">×</span>`;
    el.appendChild(chip);
  });
}

async function addTemplate() {
  const name = document.getElementById('tmpl-name').value.trim();
  const start = document.getElementById('tmpl-start').value;
  const end = document.getElementById('tmpl-end').value;
  if (!name || !start || !end) { alert('全項目を入力してください'); return; }
  await api('/api/admin/shift-templates', 'POST', { name, start_time: start, end_time: end });
  document.getElementById('tmpl-name').value = '';
  loadTemplates();
}

async function deleteTemplate(id) {
  await api('/api/admin/shift-templates/' + id, 'DELETE');
  loadTemplates();
}

async function loadShifts() {
  const year = document.getElementById('shift-year').value;
  const month = document.getElementById('shift-month').value;
  const dept = document.getElementById('shift-dept-filter').value;
  try {
    let url = `/api/admin/shifts?year=${year}&month=${month}`;
    if (dept) url += `&department_id=${dept}`;
    const [shiftRes, empRes] = await Promise.all([api(url), api('/api/admin/employees')]);
    const shiftD = await shiftRes.json();
    const empD = await empRes.json();
    shiftData = shiftD.shifts || [];
    const emps = (empD.employees || []).filter(e => !dept || true); // フィルタは後で
    renderShiftTable(parseInt(year), parseInt(month), emps);
  } catch(e) {}
}

function renderShiftTable(year, month, emps) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = Array.from({length: daysInMonth}, (_, i) => {
    const d = new Date(year, month - 1, i + 1);
    return { day: i + 1, wd: ['日','月','火','水','木','金','土'][d.getDay()], isWeekend: d.getDay() === 0 || d.getDay() === 6 };
  });
  const today = new Date().toISOString().slice(0, 10);

  // ヘッダー
  const thead = document.getElementById('shift-thead');
  thead.innerHTML = '<tr><th style="min-width:100px;position:sticky;left:0;background:#F8FAFC;z-index:1">氏名</th>' +
    days.map(d => {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d.day).padStart(2,'0')}`;
      const color = d.wd === '日' ? '#FEE2E2' : d.wd === '土' ? '#DBEAFE' : '#F8FAFC';
      const isToday = dateStr === today;
      return `<th style="min-width:70px;background:${isToday ? '#EFF6FF' : color};text-align:center;font-size:0.75rem;padding:6px 4px;${isToday ? 'border-bottom:2px solid var(--primary-light)' : ''}">
        ${d.day}<br><span style="color:${d.wd==='日'?'var(--danger)':d.wd==='土'?'var(--primary-light)':'var(--text-muted)'}">${d.wd}</span>
      </th>`;
    }).join('') + '</tr>';

  // 従業員行
  const tbody = document.getElementById('shift-tbody');
  tbody.innerHTML = '';

  // シフトデータをマップ化
  const shiftMap = {};
  shiftData.forEach(s => {
    if (!shiftMap[s.employee_id]) shiftMap[s.employee_id] = {};
    shiftMap[s.employee_id][s.shift_date] = s;
  });

  emps.forEach(emp => {
    const tr = document.createElement('tr');
    const dateStr0 = `${year}-${String(month).padStart(2,'0')}-01`;
    const empShifts = shiftMap[emp.employee_id] || {};

    tr.innerHTML = `<td style="position:sticky;left:0;background:white;z-index:1;font-weight:600;white-space:nowrap;padding:8px 12px">
      ${emp.name}<br><span style="font-size:0.75rem;color:var(--text-muted)">${emp.department || ''}</span>
    </td>` + days.map(d => {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d.day).padStart(2,'0')}`;
      const shift = empShifts[dateStr];
      const bgColor = d.wd === '日' ? '#FFF5F5' : d.wd === '土' ? '#F0F9FF' : 'white';
      if (shift) {
        return `<td style="background:${bgColor};text-align:center;padding:4px;font-size:0.75rem">
          <div style="background:#EFF6FF;border-radius:6px;padding:3px 4px;cursor:pointer" onclick="openShiftEdit('${emp.employee_id}','${emp.name}','${dateStr}','${shift.start_time}','${shift.end_time}',${shift.id})">
            <div style="font-weight:700;color:var(--primary)">${shift.start_time.slice(0,5)}</div>
            <div style="color:var(--text-muted)">${shift.end_time.slice(0,5)}</div>
          </div>
        </td>`;
      } else {
        return `<td style="background:${bgColor};text-align:center;padding:4px" onclick="openShiftEdit('${emp.employee_id}','${emp.name}','${dateStr}','','',null)">
          <div style="border:1px dashed var(--border);border-radius:6px;padding:6px;cursor:pointer;color:var(--text-muted);font-size:0.7rem">＋</div>
        </td>`;
      }
    }).join('');
    tbody.appendChild(tr);
  });

  if (!emps.length) {
    tbody.innerHTML = '<tr><td colspan="100" style="text-align:center;color:var(--text-muted);padding:20px">従業員が登録されていません</td></tr>';
  }
}

// シフト編集モーダル（インライン）
let editingShift = null;
function openShiftEdit(empId, empName, shiftDate, startTime, endTime, shiftId) {
  editingShift = { empId, shiftDate, shiftId };
  const dispDate = shiftDate.replace(/-/g, '/');

  const existing = document.getElementById('shift-edit-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'shift-edit-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:360px">
      <div class="modal-title">📅 シフト設定</div>
      <div style="font-weight:600;margin-bottom:16px">${empName} / ${dispDate}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${shiftTemplates.map(t => `
          <button class="btn-outline btn-sm" onclick="applyTemplate('${t.start_time}','${t.end_time}')">${t.name}<br><span style="font-size:0.72rem">${t.start_time}〜${t.end_time}</span></button>
        `).join('')}
      </div>
      <div style="display:flex;gap:12px;margin-bottom:16px">
        <div class="form-group" style="margin:0;flex:1"><label>開始</label><input type="time" id="se-start" value="${startTime || '09:00'}"></div>
        <div class="form-group" style="margin:0;flex:1"><label>終了</label><input type="time" id="se-end" value="${endTime || '18:00'}"></div>
      </div>
      <div class="modal-footer">
        ${shiftId ? `<button class="btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="deleteShift(${shiftId})">削除</button>` : ''}
        <button class="btn-outline" onclick="document.getElementById('shift-edit-overlay').remove()">キャンセル</button>
        <button class="btn-primary" style="width:auto;padding:10px 20px" onclick="saveShift()">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function applyTemplate(start, end) {
  document.getElementById('se-start').value = start;
  document.getElementById('se-end').value = end;
}

async function saveShift() {
  const { empId, shiftDate } = editingShift;
  const start = document.getElementById('se-start').value;
  const end = document.getElementById('se-end').value;
  if (!start || !end) { alert('時刻を入力してください'); return; }
  const res = await api('/api/admin/shifts', 'POST', {
    employee_id: empId, shift_date: shiftDate, start_time: start, end_time: end
  });
  if (!res.ok) { const d = await res.json(); alert(d.detail || 'エラー'); return; }
  document.getElementById('shift-edit-overlay').remove();
  loadShifts();
}

async function deleteShift(shiftId) {
  if (!confirm('このシフトを削除しますか？')) return;
  await api('/api/admin/shifts/' + shiftId, 'DELETE');
  document.getElementById('shift-edit-overlay').remove();
  loadShifts();
}

// 初期ロード
loadDashboard();
loadDeptOptions('att-dept', true);
