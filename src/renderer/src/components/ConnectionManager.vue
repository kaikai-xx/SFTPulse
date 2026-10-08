<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import type { ConnectionProfile, ConnectionInput } from '../../../main/types'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'saved'): void
}>()

const list = ref<ConnectionProfile[]>([])
const dialogOpen = ref(false)
const formRef = ref<FormInstance>()
const editing = ref(false)

const form = reactive<ConnectionInput>({
  id: undefined,
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  remoteDir: '/www/wwwroot'
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入连接名称', trigger: 'blur' }],
  host: [{ required: true, message: '请输入服务器地址', trigger: 'blur' }],
  port: [{ required: true, message: '请输入端口', trigger: 'blur' }],
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }]
}

async function refresh(): Promise<void> {
  list.value = await window.api.listConnections()
}

watch(
  () => props.visible,
  (v) => {
    if (v) refresh()
  }
)

function resetForm(): void {
  editing.value = false
  Object.assign(form, {
    id: undefined,
    name: '',
    host: '',
    port: 22,
    username: 'root',
    authType: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    remoteDir: '/www/wwwroot'
  })
  dialogOpen.value = true
}

function editOne(c: ConnectionProfile): void {
  editing.value = true
  Object.assign(form, {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    authType: c.authType,
    password: '', // 不回显旧密码，留空表示沿用
    privateKeyPath: c.privateKeyPath || '',
    passphrase: '',
    remoteDir: c.remoteDir || '/'
  })
  dialogOpen.value = true
}

async function pickKey(): Promise<void> {
  const p = await window.api.pickPrivateKey()
  if (p) form.privateKeyPath = p
}

async function submit(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return
  if (form.authType === 'password' && !editing.value && !form.password) {
    ElMessage.warning('请填写密码')
    return
  }
  list.value = await window.api.saveConnection({ ...form })
  dialogOpen.value = false
  ElMessage.success('已保存')
  emit('saved')
}

async function removeOne(c: ConnectionProfile): Promise<void> {
  await ElMessageBox.confirm(`确定删除连接「${c.name}」？`, '确认', { type: 'warning' })
  list.value = await window.api.deleteConnection(c.id)
  emit('saved')
}

function close(): void {
  emit('update:visible', false)
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="连接管理"
    width="640px"
    @update:model-value="close"
  >
    <div class="mgr-toolbar">
      <el-button type="primary" @click="resetForm">➕ 新建连接</el-button>
      <span class="hint">配置保存在本机，密码经系统密钥链加密</span>
    </div>

    <el-table :data="list" border size="small" style="width: 100%; margin-top: 12px">
      <el-table-column prop="name" label="名称" min-width="120" />
      <el-table-column label="目标" min-width="180">
        <template #default="s">{{ s.row.username }}@{{ s.row.host }}:{{ s.row.port }}</template>
      </el-table-column>
      <el-table-column label="认证" width="80">
        <template #default="s">{{ s.row.authType === 'password' ? '密码' : '密钥' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="130" align="center">
        <template #default="s">
          <el-button link type="primary" @click="editOne(s.row)">编辑</el-button>
          <el-button link type="danger" @click="removeOne(s.row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <div style="padding: 20px; color: #9ca3af">暂无连接，点击「新建连接」添加</div>
      </template>
    </el-table>

    <el-dialog
      v-model="dialogOpen"
      :title="editing ? '编辑连接' : '新建连接'"
      width="520px"
      append-to-body
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="例如：生产服务器" />
        </el-form-item>
        <el-form-item label="主机" prop="host">
          <el-input v-model="form.host" placeholder="IP 或域名" />
        </el-form-item>
        <el-form-item label="端口" prop="port">
          <el-input-number v-model="form.port" :min="1" :max="65535" />
        </el-form-item>
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" />
        </el-form-item>
        <el-form-item label="认证方式">
          <el-radio-group v-model="form.authType">
            <el-radio-button value="password">密码</el-radio-button>
            <el-radio-button value="privatekey">私钥</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="form.authType === 'password'">
          <el-form-item label="密码">
            <el-input v-model="form.password" type="password" show-password :placeholder="editing ? '留空则不修改' : ''" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="私钥文件">
            <el-input v-model="form.privateKeyPath" readonly placeholder="选择私钥文件">
              <template #append><el-button @click="pickKey">浏览</el-button></template>
            </el-input>
          </el-form-item>
          <el-form-item label="口令">
            <el-input v-model="form.passphrase" type="password" show-password placeholder="私钥口令（无则留空）" />
          </el-form-item>
        </template>
        <el-form-item label="默认目录">
          <el-input v-model="form.remoteDir" placeholder="上传/浏览的默认远程目录" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <template #footer>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mgr-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.mgr-toolbar .hint {
  font-size: 12px;
  color: #9ca3af;
}
</style>
