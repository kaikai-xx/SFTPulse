<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import type { DbConnection, DbSyncEvent, ConnectionProfile } from '../../../main/types'

// ---------- 连接列表 ----------
const dbs = ref<DbConnection[]>([])
const sshConns = ref<ConnectionProfile[]>([])

async function refresh(): Promise<void> {
  dbs.value = await window.api.listDatabases()
  sshConns.value = await window.api.listConnections()
}

// ---------- 连接编辑对话框 ----------
const dlgVisible = ref(false)
const editing = ref(false)
const formRef = ref<FormInstance>()
const form = reactive<DbConnection>({
  id: '',
  name: '',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: '',
  sshConnId: ''
})
const rules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  host: [{ required: true, message: '请输入数据库地址', trigger: 'blur' }],
  user: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  database: [{ required: true, message: '请从下拉选择或输入库名', trigger: 'change' }]
}

const dbOptions = ref<string[]>([])
const loadingDbs = ref(false)
async function loadDatabases(): Promise<void> {
  if (!form.host || !form.user) return void ElMessage.warning('请先填写主机与用户名（需隧道也先选上）')
  loadingDbs.value = true
  try {
    dbOptions.value = await window.api.listDbNames(JSON.parse(JSON.stringify(form)))
    if (dbOptions.value.length) ElMessage.success(`找到 ${dbOptions.value.length} 个数据库，请在下拉中选择`)
    else ElMessage.info('该用户下没有可显示的数据库')
  } catch (e) {
    ElMessage.error('加载失败：' + (e as Error).message)
  } finally {
    loadingDbs.value = false
  }
}

function newConn(): void {
  editing.value = false
  dbOptions.value = []
  Object.assign(form, {
    id: '',
    name: '',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: '',
    sshConnId: ''
  })
  dlgVisible.value = true
}
function editConn(c: DbConnection): void {
  editing.value = true
  dbOptions.value = c.database ? [c.database] : []
  Object.assign(form, { ...c, password: '' }) // 不回显密码，留空表示沿用
  dlgVisible.value = true
}
async function saveConn(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return
  if (!editing.value && !form.password) return void ElMessage.warning('请填写数据库密码')
  dbs.value = await window.api.saveDatabase(JSON.parse(JSON.stringify(form)))
  dlgVisible.value = false
  ElMessage.success('已保存')
}
async function removeConn(c: DbConnection): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除数据库连接「${c.name}」？`, '确认', { type: 'warning' })
  } catch {
    return
  }
  dbs.value = await window.api.deleteDatabase(c.id)
  if (sourceId.value === c.id) sourceId.value = ''
  if (targetId.value === c.id) targetId.value = ''
}
const testingId = ref('')
async function testConn(c: DbConnection): Promise<void> {
  testingId.value = c.id
  try {
    const info = await window.api.testDatabase(c.id)
    ElMessage.success(`连接成功：${info}`)
  } catch (e) {
    ElMessage.error('连接失败：' + (e as Error).message)
  } finally {
    testingId.value = ''
  }
}

// ---------- 同步表单 ----------
const sourceId = ref('')
const targetId = ref('')
const tables = ref<string[]>([])
const selectedTables = ref<string[]>([])
const loadingTables = ref(false)
const opt = reactive({ structure: true, data: true, dropExisting: true, truncateBeforeInsert: true })

function swap(): void {
  const s = sourceId.value
  sourceId.value = targetId.value
  targetId.value = s
  tables.value = []
  selectedTables.value = []
}

async function loadTables(): Promise<void> {
  if (!sourceId.value) return void ElMessage.warning('请先选择源数据库')
  loadingTables.value = true
  try {
    tables.value = await window.api.listDbTables(sourceId.value)
    selectedTables.value = [...tables.value]
    if (!tables.value.length) ElMessage.info('源库没有表')
  } catch (e) {
    ElMessage.error('读取表列表失败：' + (e as Error).message)
  } finally {
    loadingTables.value = false
  }
}
function selectAll(): void {
  selectedTables.value = [...tables.value]
}
function selectNone(): void {
  selectedTables.value = []
}

// ---------- 控制台 ----------
interface Line {
  text: string
  cls: string
}
const lines = ref<Line[]>([])
const syncing = ref(false)
const cur = ref<{ table: string; index: number; count: number; rowsDone: number; rowsTotal: number; phase: string } | null>(
  null
)
const consoleRef = ref<HTMLElement>()

function cls(t: string): string {
  if (t.startsWith('✖')) return 'err'
  if (t.startsWith('⚠')) return 'warn'
  if (t.startsWith('✔')) return 'ok'
  if (t.startsWith('▶')) return 'run'
  if (t.startsWith('·')) return 'dim'
  return ''
}
function push(text: string): void {
  lines.value.push({ text, cls: cls(text) })
  nextTick(() => {
    if (consoleRef.value) consoleRef.value.scrollTop = consoleRef.value.scrollHeight
  })
}

let off: (() => void) | null = null
onMounted(() => {
  void refresh()
  off = window.api.onDbSyncEvent((ev: DbSyncEvent) => {
    if (ev.kind === 'log') push(ev.text)
    else cur.value = { table: ev.table, index: ev.index, count: ev.count, rowsDone: ev.rowsDone, rowsTotal: ev.rowsTotal, phase: ev.phase }
  })
})
onUnmounted(() => off?.())

const overallPercent = computed(() => {
  const c = cur.value
  if (!c || !c.count) return 0
  const tablePart = c.rowsTotal > 0 ? c.rowsDone / c.rowsTotal : c.phase === '结构' ? 1 : 0
  return Math.min(100, Math.round(((c.index - 1 + tablePart) / c.count) * 100))
})

async function startSync(): Promise<void> {
  if (syncing.value) return
  if (!sourceId.value || !targetId.value) return void ElMessage.warning('请选择源与目标数据库')
  if (sourceId.value === targetId.value) return void ElMessage.warning('源与目标不能相同')
  if (!selectedTables.value.length) return void ElMessage.warning('请至少选择一张表')
  if (!opt.structure && !opt.data) return void ElMessage.warning('请至少勾选「结构」或「数据」')
  const src = dbs.value.find((d) => d.id === sourceId.value)?.name
  const tgt = dbs.value.find((d) => d.id === targetId.value)?.name
  try {
    await ElMessageBox.confirm(
      `将「${src}」的 ${selectedTables.value.length} 张表同步到「${tgt}」。${
        opt.dropExisting ? '⚠ 目标同名表会被删除重建；' : ''
      }${opt.truncateBeforeInsert && opt.data ? '⚠ 目标表数据会被清空后写入。' : ''}确认继续？`,
      '同步确认',
      { type: 'warning', confirmButtonText: '开始同步' }
    )
  } catch {
    return
  }
  syncing.value = true
  lines.value = []
  cur.value = null
  try {
    const failed = await window.api.syncDatabase({
      sourceId: sourceId.value,
      targetId: targetId.value,
      tables: [...selectedTables.value],
      structure: opt.structure,
      data: opt.data,
      dropExisting: opt.dropExisting,
      truncateBeforeInsert: opt.truncateBeforeInsert
    })
    if (failed) ElMessage.warning(`同步结束，${failed} 张表失败`)
    else ElMessage.success('同步完成')
  } catch (e) {
    push('✖ 同步异常：' + (e as Error).message)
    ElMessage.error('同步异常')
  } finally {
    syncing.value = false
    cur.value = null
  }
}

function clearConsole(): void {
  lines.value = []
  cur.value = null
}
</script>

<template>
  <div class="db-panel">
    <!-- 左：连接管理 -->
    <div class="col-left">
      <div class="col-head">
        <span>数据库连接</span>
        <el-button size="small" type="primary" @click="newConn">➕ 新建</el-button>
      </div>
      <el-scrollbar class="conn-scroll">
        <div v-for="c in dbs" :key="c.id" class="conn-card">
          <div class="cc-main">
            <div class="cc-name">{{ c.name }}</div>
            <div class="cc-sub mono">{{ c.user }}@{{ c.host }}:{{ c.port }}/{{ c.database }}</div>
            <div v-if="c.sshConnId" class="cc-tunnel">🔒 经 SSH 隧道：{{ sshConns.find((s) => s.id === c.sshConnId)?.name || '（连接已删除）' }}</div>
          </div>
          <div class="cc-ops">
            <el-button link type="success" :loading="testingId === c.id" @click="testConn(c)">测试</el-button>
            <el-button link type="primary" @click="editConn(c)">编辑</el-button>
            <el-button link type="danger" @click="removeConn(c)">删除</el-button>
          </div>
        </div>
        <el-empty v-if="!dbs.length" description="暂无数据库连接，点击「新建」" :image-size="60" />
      </el-scrollbar>
    </div>

    <!-- 右：同步 -->
    <div class="col-right">
      <div class="sync-form">
        <div class="row">
          <el-select v-model="sourceId" placeholder="源数据库" filterable style="flex: 1">
            <el-option v-for="d in dbs" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
          <el-button :disabled="!dbs.length" @click="swap" title="交换源与目标">⇄</el-button>
          <el-select v-model="targetId" placeholder="目标数据库" filterable style="flex: 1">
            <el-option v-for="d in dbs" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </div>

        <div class="row">
          <el-button :loading="loadingTables" :disabled="!sourceId" @click="loadTables">🔄 从源库加载表</el-button>
          <el-button link type="primary" :disabled="!tables.length" @click="selectAll">全选</el-button>
          <el-button link type="info" :disabled="!tables.length" @click="selectNone">清空</el-button>
          <span class="tbl-count mono">{{ selectedTables.length }}/{{ tables.length }} 张表</span>
        </div>

        <el-select
          v-model="selectedTables"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          placeholder="选择要同步的表"
          style="width: 100%"
          :disabled="!tables.length"
        >
          <el-option v-for="t in tables" :key="t" :label="t" :value="t" />
        </el-select>

        <div class="row opts">
          <el-checkbox v-model="opt.structure">同步表结构</el-checkbox>
          <el-checkbox v-model="opt.data">同步数据</el-checkbox>
          <el-checkbox v-model="opt.dropExisting" :disabled="!opt.structure">目标已存在则删除重建</el-checkbox>
          <el-checkbox v-model="opt.truncateBeforeInsert" :disabled="!opt.data">写入前清空目标数据</el-checkbox>
        </div>

        <div class="row">
          <el-button type="primary" :loading="syncing" @click="startSync">🚀 开始同步</el-button>
          <div v-if="cur" class="prog">
            <el-progress :percentage="overallPercent" :stroke-width="12" style="width: 220px" striped striped-flow />
            <span class="mono prog-text">[{{ cur.index }}/{{ cur.count }}] {{ cur.table }} · {{ cur.phase }} {{ cur.rowsDone }}/{{ cur.rowsTotal }}</span>
          </div>
        </div>
      </div>

      <div class="console-head">
        <span>同步日志</span>
        <el-button link size="small" @click="clearConsole">清空</el-button>
      </div>
      <div ref="consoleRef" class="console mono">
        <div v-for="(l, i) in lines" :key="i" :class="['ln', l.cls]">{{ l.text }}</div>
        <div v-if="!lines.length" class="ln dim">选择源/目标、加载并勾选表，点击「开始同步」。支持本地↔服务器双向。</div>
      </div>
    </div>

    <!-- 连接编辑对话框 -->
    <el-dialog v-model="dlgVisible" :title="editing ? '编辑数据库连接' : '新建数据库连接'" width="520px" append-to-body>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="92px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="例如：本地 EduStack / 生产库" />
        </el-form-item>
        <el-form-item label="隧道" prop="sshConnId">
          <el-select v-model="form.sshConnId" placeholder="不直连时可选：经由某条 SSH 连接访问" clearable style="width: 100%">
            <el-option v-for="s in sshConns" :key="s.id" :label="`${s.name} (${s.username}@${s.host})`" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="主机" prop="host">
          <el-input v-model="form.host" :placeholder="form.sshConnId ? '从 SSH 服务器视角的地址，如 127.0.0.1' : 'IP 或域名'" />
        </el-form-item>
        <el-form-item label="端口" prop="port">
          <el-input-number v-model="form.port" :min="1" :max="65535" />
        </el-form-item>
        <el-form-item label="用户名" prop="user">
          <el-input v-model="form.user" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password :placeholder="editing ? '留空则不修改' : ''" />
        </el-form-item>
        <el-form-item label="数据库" prop="database">
          <div class="db-pick">
            <el-select
              v-model="form.database"
              filterable
              allow-create
              default-first-option
              placeholder="点右侧「加载」选择，或手动输入"
              style="flex: 1"
            >
              <el-option v-for="db in dbOptions" :key="db" :label="db" :value="db" />
            </el-select>
            <el-button :loading="loadingDbs" @click="loadDatabases">🔄 加载</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlgVisible = false">取消</el-button>
        <el-button type="primary" @click="saveConn">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.db-panel {
  display: flex;
  gap: 14px;
  height: 100%;
  min-height: 520px;
}
.col-left {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #2a3644;
  border-radius: 8px;
  overflow: hidden;
}
.col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-weight: 600;
  color: #e5e7eb;
  border-bottom: 1px solid #2a3644;
  background: #10181f;
}
.conn-scroll {
  flex: 1;
  padding: 10px;
}
.conn-card {
  position: relative;
  border: 1px solid #2a3644;
  border-radius: 10px;
  padding: 12px 12px 10px 16px;
  margin-bottom: 10px;
  background: linear-gradient(180deg, #16212c 0%, #121a23 100%);
  overflow: hidden;
  transition: border-color 0.15s, transform 0.15s;
}
.conn-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: #3b82f6;
}
.conn-card:hover {
  border-color: #3b82f6;
  transform: translateY(-1px);
}
.cc-name {
  font-weight: 700;
  font-size: 14px;
  color: #f1f5f9;
}
.cc-sub {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 3px;
}
.cc-tunnel {
  display: inline-block;
  font-size: 11.5px;
  color: #7dd3fc;
  background: rgba(56, 189, 248, 0.12);
  border-radius: 4px;
  padding: 1px 6px;
  margin-top: 6px;
}
.cc-ops {
  margin-top: 8px;
  display: flex;
  gap: 6px;
}
.col-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sync-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 12px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.opts {
  flex-wrap: wrap;
}
.tbl-count {
  font-size: 12px;
  color: #94a3b8;
  margin-left: auto;
}
.prog {
  display: flex;
  align-items: center;
  gap: 10px;
}
.prog-text {
  font-size: 12px;
  color: #cbd5e1;
}
.console-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 600;
  border-top: 1px solid #2a3644;
}
.console {
  flex: 1;
  background: #0b1017;
  border: 1px solid #2a3644;
  border-radius: 8px;
  padding: 10px 12px;
  overflow-y: auto;
  font-size: 12.5px;
  line-height: 1.7;
  min-height: 160px;
}
.ln {
  white-space: pre-wrap;
  word-break: break-all;
  color: #e5e7eb;
}
.ln.err {
  color: #f87171;
}
.ln.warn {
  color: #fbbf24;
}
.ln.ok {
  color: #34d399;
}
.ln.run {
  color: #60a5fa;
}
.ln.dim {
  color: #94a3b8;
}
.db-pick {
  display: flex;
  gap: 8px;
  width: 100%;
}
.mono {
  font-family: 'Consolas', 'Menlo', monospace;
}
</style>
