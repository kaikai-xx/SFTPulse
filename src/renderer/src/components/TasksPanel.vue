<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Task, TaskGroup, TaskEvent, UploadProgress, ConnectionProfile, RemoteEntry } from '../../../main/types'

const tasks = ref<Task[]>([])
const groups = ref<TaskGroup[]>([])
const connections = ref<ConnectionProfile[]>([])
const runningId = ref<string>('')
const runningGroupId = ref<string>('')

/** 运行控制台 */
interface Line {
  text: string
  cls: string
}
const lines = ref<Line[]>([])
const consoleEl = ref<HTMLElement | null>(null)

/** 队列进度（任务上传批次） */
const queue = ref<{ name: string; size: number; pct: number; done: boolean }[]>([])
const progress = ref<UploadProgress | null>(null)
const overallPercent = computed(() => {
  const p = progress.value
  if (!p || !p.count) return 0
  const doneUnits = p.index - 1 + (p.total ? p.transferred / p.total : 0)
  return Math.min(100, Math.round((doneUnits / p.count) * 100))
})

function connLabel(connId: string): string {
  const c = connections.value.find((x) => x.id === connId)
  return c ? `${c.name} (${c.username}@${c.host})` : '⚠ 连接已删除'
}

function cls4(text: string): string {
  if (text.startsWith('✔')) return 'ok'
  if (text.startsWith('✖')) return 'err'
  if (text.startsWith('⚠')) return 'warn'
  if (text.startsWith('$')) return 'cmd'
  if (text.startsWith('#') || text.startsWith('──')) return 'dim'
  return ''
}
function push(text: string, cls = ''): void {
  lines.value.push({ text, cls: cls || cls4(text) })
  if (lines.value.length > 3000) lines.value.splice(0, lines.value.length - 3000)
  requestAnimationFrame(() => {
    if (consoleEl.value) consoleEl.value.scrollTop = consoleEl.value.scrollHeight
  })
}

let offTask: (() => void) | null = null
onMounted(async () => {
  offTask = window.api.onTaskEvent((ev: TaskEvent) => {
    switch (ev.kind) {
      case 'log':
        push(ev.text)
        break
      case 'queue':
        queue.value = ev.entries.map((e) => ({ ...e, pct: 0, done: false }))
        break
      case 'progress':
        progress.value = { ...ev.p }
        {
          const item = queue.value[ev.p.index - 1]
          if (item) {
            item.pct = ev.p.total ? Math.round((ev.p.transferred / ev.p.total) * 100) : 100
            item.done = ev.p.done
          }
        }
        break
      case 'exec':
        push(ev.chunk.data.replace(/\n$/, ''), ev.chunk.stream === 'stderr' ? 'warn' : 'out')
        break
    }
  })
  tasks.value = await window.api.listTasks()
  groups.value = await window.api.listGroups()
  await refreshConnections()
})
onUnmounted(() => offTask?.())

// ---------- 编辑对话框 ----------
const dialogVisible = ref(false)
const form = ref<Task>({ id: '', name: '', connId: '', localPaths: [], remoteDir: '', commands: [] })
const commandsText = ref('')

async function refreshConnections(): Promise<void> {
  connections.value = await window.api.listConnections()
}

// 每次打开对话框都重新拉取，保证「连接管理」里新增的连接立即可见
watch(dialogVisible, (v) => {
  if (v) void refreshConnections()
})

function newTask(): void {
  form.value = { id: Date.now().toString(36), name: '', connId: connections.value[0]?.id || '', localPaths: [], remoteDir: '/', commands: [] }
  commandsText.value = ''
  dialogVisible.value = true
}

function editTask(t: Task): void {
  form.value = JSON.parse(JSON.stringify(t)) as Task
  commandsText.value = t.commands.join('\n')
  dialogVisible.value = true
}

async function pickFiles(): Promise<void> {
  const picked = await window.api.pickFiles()
  if (picked.length) form.value.localPaths = Array.from(new Set([...form.value.localPaths, ...picked]))
}
async function pickDir(): Promise<void> {
  const picked = await window.api.pickDir()
  if (picked.length) form.value.localPaths = Array.from(new Set([...form.value.localPaths, ...picked]))
}
function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

async function saveTask(): Promise<void> {
  const t = form.value
  if (!t.name.trim()) return void ElMessage.warning('请填写任务名称')
  if (!t.connId) return void ElMessage.warning('请选择绑定的连接')
  if (t.localPaths.length && !t.remoteDir.trim())
    return void ElMessage.warning('请通过「浏览」选择远程目录')
  if (!t.commands.length && !t.localPaths.length) return void ElMessage.warning('请至少添加文件或命令')
  t.commands = commandsText.value.split('\n').map((s) => s.trim()).filter(Boolean)
  tasks.value = await window.api.saveTask(JSON.parse(JSON.stringify(t)))
  dialogVisible.value = false
  ElMessage.success('任务已保存')
}

async function removeTask(t: Task): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除任务「${t.name}」？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  tasks.value = await window.api.deleteTask(t.id)
}

async function run(t: Task): Promise<void> {
  if (runningId.value || runningGroupId.value) {
    ElMessage.warning('已有任务/流程在运行中')
    return
  }
  runningId.value = t.id
  lines.value = []
  queue.value = []
  progress.value = null
  try {
    await window.api.runTask(t.id)
  } catch {
    /* 失败详情已在控制台展示 */
  } finally {
    runningId.value = ''
    progress.value = null
    queue.value = []
  }
}

// ---------- 部署流程（大任务） ----------
const groupDialogVisible = ref(false)
const groupForm = ref<TaskGroup>({ id: '', name: '', taskIds: [] })

function newGroup(): void {
  groupForm.value = { id: Date.now().toString(36), name: '', taskIds: [] }
  groupDialogVisible.value = true
}
function editGroup(g: TaskGroup): void {
  groupForm.value = JSON.parse(JSON.stringify(g)) as TaskGroup
  groupDialogVisible.value = true
}
async function saveGroup(): Promise<void> {
  const g = groupForm.value
  if (!g.name.trim()) return void ElMessage.warning('请填写流程名称')
  if (!g.taskIds.length) return void ElMessage.warning('请至少选择一个任务')
  groups.value = await window.api.saveGroup(JSON.parse(JSON.stringify(g)))
  groupDialogVisible.value = false
  ElMessage.success('流程已保存')
}
async function removeGroup(g: TaskGroup): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除流程「${g.name}」？（不会删除其中的任务）`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  groups.value = await window.api.deleteGroup(g.id)
}
async function runGroup(g: TaskGroup): Promise<void> {
  if (runningId.value || runningGroupId.value) {
    ElMessage.warning('已有任务/流程在运行中')
    return
  }
  runningGroupId.value = g.id
  lines.value = []
  queue.value = []
  progress.value = null
  try {
    await window.api.runGroup(g.id)
  } catch {
    /* 详情已展示 */
  } finally {
    runningGroupId.value = ''
    progress.value = null
    queue.value = []
  }
}
function groupSteps(g: TaskGroup): { name: string; lost: boolean }[] {
  return g.taskIds.map((id) => {
    const t = tasks.value.find((x) => x.id === id)
    return { name: t ? t.name : '已删除的任务', lost: !t }
  })
}

// 编辑时同步命令文本
function onDialogClosed(): void {
  form.value.commands = commandsText.value.split('\n').map((s) => s.trim()).filter(Boolean)
}

// ---------- 远程目录选择器 ----------
const dirPickerVisible = ref(false)
const dirPickerLoading = ref(false)
const dirPath = ref('/')
const dirFolders = ref<RemoteEntry[]>([])

/** 选择器需要一个可用连接：未连接则自动连接一次 */
async function ensureConnForPick(): Promise<boolean> {
  const id = form.value.connId
  if (!id) {
    ElMessage.warning('请先选择绑定连接')
    return false
  }
  try {
    if (await window.api.status(id)) return true
    await window.api.connect(id)
    ElMessage.success(`已连接到 ${connections.value.find((c) => c.id === id)?.host ?? ''}`)
    return true
  } catch (e) {
    ElMessage.error('连接失败：' + (e as Error).message)
    return false
  }
}

async function loadFolders(path: string): Promise<void> {
  dirPickerLoading.value = true
  try {
    const entries = await window.api.listRemote(form.value.connId, path)
    dirFolders.value = entries
      .filter((x) => x.directory && x.name !== '.')
      .sort((a, b) => a.name.localeCompare(b.name))
    dirPath.value = path
  } catch (e) {
    ElMessage.error('读取目录失败：' + (e as Error).message)
  } finally {
    dirPickerLoading.value = false
  }
}

async function openDirPicker(): Promise<void> {
  if (!(await ensureConnForPick())) return
  dirPickerVisible.value = true
  void loadFolders(form.value.remoteDir?.trim() || '/')
}

function parentOf(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i)
}

async function createSubDir(): Promise<void> {
  let name: string
  try {
    const r = await ElMessageBox.prompt('新目录名称（在当前目录下创建）', '新建文件夹', {
      inputPattern: /^[^/\\]+$/,
      inputErrorMessage: '名称不能为空且不能包含 / \\'
    })
    name = r.value.trim()
  } catch {
    return
  }
  const target = (dirPath.value === '/' ? '' : dirPath.value) + '/' + name
  try {
    await window.api.mkdirRemote(form.value.connId, target)
    ElMessage.success('已创建：' + target)
    await loadFolders(dirPath.value)
  } catch (e) {
    ElMessage.error('创建失败：' + (e as Error).message)
  }
}

function pickCurrentDir(): void {
  form.value.remoteDir = dirPath.value
  dirPickerVisible.value = false
}

// ---------- 命令代码提示 ----------
interface CmdHint {
  cmd: string
  desc: string
}
const CMD_LIBRARY: CmdHint[] = [
  { cmd: 'cd ', desc: '进入目录' },
  { cmd: 'ls -lh ', desc: '列出目录' },
  { cmd: 'pwd', desc: '当前路径' },
  { cmd: 'nginx -t && nginx -s reload', desc: '重载 Nginx（PATH 内）' },
  { cmd: '/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload', desc: '宝塔 Nginx 重载' },
  { cmd: 'systemctl restart nginx', desc: 'systemd 重启 Nginx' },
  { cmd: "pkill -f '.jar'", desc: '按名称结束进程' },
  { cmd: 'ps -ef | grep java', desc: '查看 Java 进程' },
  { cmd: 'nohup java -jar app.jar --spring.profiles.active=prod > app.log 2>&1 &', desc: '后台启动 jar' },
  { cmd: 'source /etc/profile && ', desc: '加载环境变量（java/nginx 找不到时）' },
  { cmd: 'tail -n 100 app.log', desc: '查看日志尾部' },
  { cmd: "curl -s -o /dev/null -w 'HTTP %{http_code}' http://127.0.0.1:8080/", desc: '健康检查' },
  { cmd: 'systemctl status ', desc: '查看服务状态' },
  { cmd: 'mv -f  ', desc: '移动/重命名' },
  { cmd: 'cp -r  ', desc: '复制' },
  { cmd: 'mkdir -p ', desc: '新建目录' },
  { cmd: 'chmod +x ', desc: '赋予可执行权限' },
  { cmd: 'unzip -o app.zip -d ', desc: '解压 zip' },
  { cmd: 'tar -zxvf .tar.gz -C ', desc: '解压 tar.gz' },
  { cmd: 'df -h', desc: '磁盘占用' },
  { cmd: 'free -m', desc: '内存占用' },
  { cmd: 'top -bn1 | head -20', desc: '负载概览' }
]

const cmdInputRef = ref<{ textarea?: HTMLTextAreaElement } | null>(null)
const showHints = ref(false)
const hintIndex = ref(0)
const linePrefix = ref('')

const hintMatches = computed(() => {
  const raw = linePrefix.value
  const p = raw.trim().toLowerCase()
  if (!p) return CMD_LIBRARY
  return CMD_LIBRARY.filter(
    (c) => c.cmd.toLowerCase().startsWith(p) || c.cmd.toLowerCase().includes(p) || c.desc.includes(raw.trim())
  )
})

function updateHints(): void {
  const ta = cmdInputRef.value?.textarea
  if (!ta) return
  const pos = ta.selectionStart
  const before = ta.value.slice(0, pos)
  const lineStart = before.lastIndexOf('\n') + 1
  linePrefix.value = before.slice(lineStart)
  hintIndex.value = 0
  showHints.value = true
}
function onCmdFocus(): void {
  updateHints()
}
function onCmdBlur(): void {
  // 留时间给 mousedown 选中（列表项用 mousedown.prevent，不会被 blur 抢先）
  setTimeout(() => (showHints.value = false), 120)
}
function acceptHint(h: CmdHint): void {
  const ta = cmdInputRef.value?.textarea
  if (!ta) return
  const pos = ta.selectionStart
  const before = ta.value.slice(0, pos)
  const after = ta.value.slice(pos)
  const lineStart = before.lastIndexOf('\n') + 1
  const newBefore = before.slice(0, lineStart) + h.cmd
  commandsText.value = newBefore + after
  showHints.value = false
  nextTick(() => {
    const np = newBefore.length
    ta.focus()
    ta.setSelectionRange(np, np)
  })
}
function onCmdKeydown(e: KeyboardEvent): void {
  const list = hintMatches.value
  if (!showHints.value || !list.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    hintIndex.value = (hintIndex.value + 1) % list.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    hintIndex.value = (hintIndex.value - 1 + list.length) % list.length
  } else if (e.key === 'Tab') {
    e.preventDefault()
    acceptHint(list[hintIndex.value])
  } else if (e.key === 'Escape') {
    showHints.value = false
  }
}
</script>

<template>
  <div class="tasks-panel">
    <div class="left">
      <div class="head">
        <span class="title">🔗 部署流程</span>
        <el-button type="primary" size="small" @click="newGroup">➕ 新建流程</el-button>
      </div>
      <div class="group-box">
        <div v-if="!groups.length" class="empty small">
          还没有流程。把「部署前端 + 部署后端」组合成一个大任务，一键依次跑完。
        </div>
        <div v-for="g in groups" :key="g.id" class="group-card" :class="{ active: runningGroupId === g.id }">
          <div class="tc-head">
            <span class="tc-name">🔗 {{ g.name }}</span>
            <el-tag v-if="runningGroupId === g.id" size="small" type="warning">运行中</el-tag>
          </div>
          <div class="steps">
            <template v-for="(s, i) in groupSteps(g)" :key="i">
              <span class="step" :class="{ lost: s.lost }">{{ s.name }}</span>
              <span v-if="i < groupSteps(g).length - 1" class="arrow">→</span>
            </template>
          </div>
          <div class="tc-btns">
            <el-button type="primary" size="small" :loading="runningGroupId === g.id" :disabled="!!runningId || (!!runningGroupId && runningGroupId !== g.id)" @click="runGroup(g)">
              ▶ 一键运行
            </el-button>
            <el-button size="small" :disabled="!!runningGroupId" @click="editGroup(g)">编辑</el-button>
            <el-button size="small" type="danger" text :disabled="!!runningGroupId" @click="removeGroup(g)">删除</el-button>
          </div>
        </div>
      </div>

      <div class="head" style="margin-top: 12px">
        <span class="title">我的任务</span>
        <el-button type="primary" size="small" @click="newTask">➕ 新建任务</el-button>
      </div>
      <el-scrollbar class="task-list">
        <div v-if="!tasks.length" class="empty">
          还没有任务。把「上传这些文件 + 执行这些命令」存成一个按钮，下次一键完成部署。
        </div>
        <div v-for="t in tasks" :key="t.id" class="task-card" :class="{ active: runningId === t.id }">
          <div class="tc-head">
            <span class="tc-name">📌 {{ t.name }}</span>
            <el-tag v-if="runningId === t.id" size="small" type="warning">运行中</el-tag>
          </div>
          <div class="tc-meta">
            连接：{{ connLabel(t.connId) }}<br />
            上传：{{ t.localPaths.length }} 个来源 → {{ t.remoteDir || '（无）' }} · 命令：{{ t.commands.length }} 条
          </div>
          <div class="tc-btns">
            <el-button type="primary" size="small" :loading="runningId === t.id" :disabled="(!!runningId && runningId !== t.id) || !!runningGroupId" @click="run(t)">
              ▶ 运行
            </el-button>
            <el-button size="small" :disabled="!!runningId || !!runningGroupId" @click="editTask(t)">编辑</el-button>
            <el-button size="small" type="danger" text :disabled="!!runningId || !!runningGroupId" @click="removeTask(t)">删除</el-button>
          </div>
        </div>
      </el-scrollbar>
    </div>

    <div class="right">
      <div class="head">
        <span class="title">运行控制台</span>
        <div v-if="progress" class="mini-progress">
          <el-progress :percentage="overallPercent" :stroke-width="14" style="width: 240px" striped striped-flow />
          <div class="mp-text mono">[{{ progress.index }}/{{ progress.count }}] {{ baseName(progress.file) || progress.file }}</div>
        </div>
        <div class="spacer"></div>
        <el-button size="small" text :disabled="!!runningId || !!runningGroupId" @click="lines = []">清空</el-button>
      </div>
      <div ref="consoleEl" class="console mono">
        <div v-if="!lines.length" class="empty">运行任务后，日志与命令输出将显示在这里</div>
        <div v-for="(l, i) in lines" :key="i" class="line" :class="l.cls">{{ l.text }}</div>
      </div>
      <div v-if="queue.length && (runningId || runningGroupId)" class="queue-strip">
        <div class="qs-head mono">传输队列 · {{ queue.filter((q) => q.done).length }}/{{ queue.length }} 完成</div>
        <el-scrollbar class="qs-scroll">
          <div class="qs-items">
            <el-tag v-for="(q, i) in queue" :key="i" size="small" :type="q.done ? 'success' : 'info'" class="q-tag">
              {{ q.done ? '✔' : '⏳' }} {{ q.name }}
            </el-tag>
          </div>
        </el-scrollbar>
      </div>
    </div>

    <!-- 任务编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="form.name ? '编辑任务' : '新建任务'" width="640px" @closed="onDialogClosed">
      <el-form label-width="86px">
        <el-form-item label="任务名称">
          <el-input v-model="form.name" placeholder="例如：部署 EduStack" />
        </el-form-item>
        <el-form-item label="绑定连接">
          <el-select v-model="form.connId" placeholder="选择连接" style="width: 100%">
            <el-option
              v-for="c in connections"
              :key="c.id"
              :label="`${c.name} (${c.username}@${c.host})`"
              :value="c.id"
            />
            <template #empty>
              <div class="select-empty">暂无连接，请先在右上角「⚙ 连接管理」新建并保存一个连接</div>
            </template>
          </el-select>
        </el-form-item>
        <el-form-item label="上传来源">
          <div class="paths-box">
            <div class="row-btns">
              <el-button size="small" @click="pickFiles">➕ 选文件</el-button>
              <el-button size="small" @click="pickDir">📂 选文件夹</el-button>
            </div>
            <div v-for="(p, i) in form.localPaths" :key="p" class="path-item">
              <span :title="p">{{ baseName(p) }}</span>
              <el-button link type="danger" size="small" @click="form.localPaths.splice(i, 1)">移除</el-button>
            </div>
            <div v-if="!form.localPaths.length" class="dim">（不选则跳过上传，只执行命令）</div>
          </div>
        </el-form-item>
        <el-form-item label="远程目录">
          <div class="dir-row">
            <el-input v-model="form.remoteDir" readonly placeholder="点击右侧「浏览」从服务器选择" />
            <el-button @click="openDirPicker">📂 浏览</el-button>
          </div>
        </el-form-item>
        <el-form-item label="执行命令">
          <div class="cmd-wrap">
            <el-input
              ref="cmdInputRef"
              v-model="commandsText"
              type="textarea"
              :rows="6"
              placeholder="每行一条，按顺序执行。输入时自动提示常用命令，↑↓ 选择、Tab 采纳。例如：&#10;pkill&#10;nginx"
              @input="updateHints"
              @focus="onCmdFocus"
              @blur="onCmdBlur"
              @click="updateHints"
              @keydown="onCmdKeydown"
            />
            <div v-if="showHints && hintMatches.length" class="cmd-hints">
              <el-scrollbar max-height="240px">
                <div
                  v-for="(h, i) in hintMatches"
                  :key="h.cmd"
                  class="hint-item"
                  :class="{ on: i === hintIndex }"
                  @mouseenter="hintIndex = i"
                  @mousedown.prevent="acceptHint(h)"
                >
                  <span class="hint-cmd mono">{{ h.cmd }}</span>
                  <span class="hint-desc">{{ h.desc }}</span>
                </div>
              </el-scrollbar>
              <div class="hint-tip">↑↓ 导航 · Tab 采纳 · Esc 收起</div>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveTask">保存</el-button>
      </template>
    </el-dialog>

    <!-- 远程目录选择器（嵌套在任务对话框上，需 append-to-body） -->
    <el-dialog v-model="dirPickerVisible" title="📂 选择远程目录" width="540px" append-to-body>
      <div class="dp-bar">
        <el-button size="small" :disabled="dirPath === '/' || dirPickerLoading" @click="loadFolders(parentOf(dirPath))">
          ⬆ 上级
        </el-button>
        <span class="dp-path mono" :title="dirPath">{{ dirPath }}</span>
        <el-button size="small" text type="primary" @click="createSubDir">➕ 新建文件夹</el-button>
      </div>
      <div v-loading="dirPickerLoading" class="dp-list">
        <div v-if="!dirFolders.length && !dirPickerLoading" class="dp-empty">（没有子目录）</div>
        <div v-for="f in dirFolders" :key="f.path" class="dp-item" @click="loadFolders(f.path)">
          <span>📁 {{ f.name }}</span>
          <span class="dp-enter">进入 ›</span>
        </div>
      </div>
      <template #footer>
        <span class="dp-hint">将选择：{{ dirPath }}</span>
        <el-button @click="dirPickerVisible = false">取消</el-button>
        <el-button type="primary" :disabled="dirPickerLoading" @click="pickCurrentDir">选择此目录</el-button>
      </template>
    </el-dialog>

    <!-- 流程编辑对话框 -->
    <el-dialog v-model="groupDialogVisible" :title="groupForm.name ? '编辑流程' : '新建流程'" width="540px" append-to-body>
      <el-form label-width="80px">
        <el-form-item label="流程名称">
          <el-input v-model="groupForm.name" placeholder="例如：部署 EduStack 全套" />
        </el-form-item>
        <el-form-item label="包含任务">
          <div class="grp-task-box">
            <el-select v-model="groupForm.taskIds" multiple filterable placeholder="选择要依次执行的任务" style="width: 100%">
              <el-option v-for="t in tasks" :key="t.id" :label="t.name" :value="t.id" />
              <template #empty>
                <div class="select-empty">还没有任务，请先在左侧新建任务</div>
              </template>
            </el-select>
            <div v-if="groupForm.taskIds.length" class="grp-preview">
              <span v-for="(id, i) in groupForm.taskIds" :key="id" class="gp-step">
                {{ i + 1 }}. {{ tasks.find((t) => t.id === id)?.name || '已删除' }}
              </span>
            </div>
            <div class="dim" style="margin-top: 6px">任务按上方选择顺序依次执行；任一任务失败，流程自动中止。</div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="groupDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveGroup">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tasks-panel {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 14px;
  height: calc(100vh - 210px);
  min-height: 420px;
}
.left,
.right {
  display: flex;
  flex-direction: column;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  padding: 12px;
  min-width: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.title {
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.task-list {
  flex: 1;
  min-height: 0;
}
.task-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.task-card.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-5);
}
.tc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.tc-name {
  font-weight: 600;
  font-size: 14px;
}
.tc-meta {
  font-size: 12px;
  color: #6b7280;
  line-height: 1.6;
  margin-bottom: 8px;
}
.tc-btns {
  display: flex;
  gap: 8px;
}
.console {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #101418;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.55;
  color: #d5dae2;
}
.line {
  white-space: pre-wrap;
  word-break: break-all;
}
.line.ok {
  color: #67c23a;
}
.line.err {
  color: #f56c6c;
}
.line.cmd {
  color: #4ea1ff;
}
.line.dim {
  color: #9ca3af;
}
.line.warn {
  color: #e6a23c;
}
.line.out {
  color: #d5dae2;
}
.queue-strip {
  margin-top: 8px;
  border-top: 1px dashed #e5e7eb;
  padding-top: 6px;
}
.qs-head {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 6px;
}
.qs-scroll {
  height: 68px;
}
.qs-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-right: 8px;
}
.q-tag {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini-progress {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mp-text {
  font-size: 11.5px;
  color: #6b7280;
}
.empty {
  color: #9ca3af;
  font-size: 13px;
  padding: 18px 6px;
  line-height: 1.6;
}
.paths-box {
  width: 100%;
}
.row-btns {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}
.path-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12.5px;
  padding: 2px 6px;
  border-radius: 4px;
}
.path-item:hover {
  background: #f3f4f6;
}
.dim {
  color: #9ca3af;
  font-size: 12px;
}
.select-empty {
  padding: 12px 16px;
  font-size: 12.5px;
  color: #9ca3af;
  line-height: 1.6;
  text-align: center;
}
.dir-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.dir-row .el-input {
  flex: 1;
}
.dp-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.dp-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: #374151;
  background: #f3f4f6;
  border-radius: 6px;
  padding: 5px 10px;
}
.dp-list {
  height: 300px;
  overflow: auto;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}
.dp-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  font-size: 13.5px;
  cursor: pointer;
}
.dp-item:hover {
  background: #f3f6ff;
}
.dp-enter {
  color: #9ca3af;
  font-size: 12px;
}
.dp-empty {
  padding: 24px;
  text-align: center;
  color: #9ca3af;
  font-size: 13px;
}
.dp-hint {
  float: left;
  line-height: 32px;
  font-size: 12px;
  color: #6b7280;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 部署流程 */
.group-box {
  max-height: 240px;
  overflow: auto;
  margin-bottom: 4px;
}
.group-card {
  border: 1px solid #e5e7eb;
  border-left: 3px solid var(--el-color-primary);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fafbff;
}
.group-card.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-5);
}
.steps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #4b5563;
  margin-bottom: 8px;
}
.step {
  background: #eef2ff;
  border-radius: 4px;
  padding: 1px 6px;
}
.step.lost {
  background: #fef0f0;
  color: #f56c6c;
  text-decoration: line-through;
}
.arrow {
  color: #9ca3af;
}
.empty.small {
  font-size: 12px;
  padding: 10px 6px;
}
/* 命令代码提示 */
.cmd-wrap {
  position: relative;
  width: 100%;
}
.cmd-hints {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  margin-top: 2px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
}
.hint-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12.5px;
}
.hint-item.on {
  background: var(--el-color-primary-light-9);
}
.hint-cmd {
  color: #111827;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60%;
}
.hint-desc {
  color: #9ca3af;
  font-size: 11.5px;
  flex-shrink: 0;
}
.hint-tip {
  border-top: 1px solid #f0f0f0;
  padding: 4px 12px;
  font-size: 11px;
  color: #b0b3b8;
}
/* 流程预览 */
.grp-task-box {
  width: 100%;
}
.grp-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.gp-step {
  background: #eef2ff;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  color: #4b5563;
}
</style>
