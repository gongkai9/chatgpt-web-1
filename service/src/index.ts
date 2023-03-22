import express from 'express'
import jwt from 'jsonwebtoken'
import { ObjectId } from 'mongodb'
import type { ChatContext, ChatMessage } from './chatgpt'
import { chatConfig, chatReplyProcess, currentModel, initApi } from './chatgpt'
import { auth } from './middleware/auth'
import { clearConfigCache, getCacheConfig, getOriginConfig } from './storage/config'
import type { ChatOptions, Config, MailConfig, SiteConfig, UserInfo } from './storage/model'
import { Status } from './storage/model'
import { clearChat, createChatRoom, createUser, deleteChat, deleteChatRoom, existsChatRoom, getChat, getChatRooms, getChats, getUser, getUserById, insertChat, renameChatRoom, updateChat, updateConfig, updateUserInfo, verifyUser } from './storage/mongo'
import { isNotEmptyString } from './utils/is'
import { sendMail } from './utils/mail'
import { checkUserVerify, getUserVerifyUrl, md5 } from './utils/security'

const app = express()
const router = express.Router()

app.use(express.static('public'))
app.use(express.json())

app.all('*', (_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'authorization, Content-Type')
  res.header('Access-Control-Allow-Methods', '*')
  next()
})

router.get('/chatrooms', auth, async (req, res) => {
  const userId = req.headers.userId
  const rooms = await getChatRooms(userId)
  const result = []
  rooms.forEach((r) => {
    result.push({
      uuid: r.roomId,
      title: r.title,
      isEdit: false,
    })
  })
  res.send({ status: 'Success', message: null, data: result })
})

router.post('/room-create', auth, async (req, res) => {
  const userId = req.headers.userId
  const { title, roomId } = req.body as { title: string; roomId: number }
  const room = await createChatRoom(userId, title, roomId)
  res.send({ status: 'Success', message: null, data: room })
})

router.post('/room-rename', auth, async (req, res) => {
  const userId = req.headers.userId
  const { title, roomId } = req.body as { title: string; roomId: number }
  const room = await renameChatRoom(userId, title, roomId)
  res.send({ status: 'Success', message: null, data: room })
})

router.post('/room-delete', auth, async (req, res) => {
  const userId = req.headers.userId
  const { roomId } = req.body as { roomId: number }
  if (!roomId || !await existsChatRoom(userId, roomId)) {
    res.send({ status: 'Fail', message: 'Unknow room', data: null })
    return
  }
  await deleteChatRoom(userId, roomId)
  res.send({ status: 'Success', message: null })
})

router.get('/chat-hisroty', auth, async (req, res) => {
  const userId = req.headers.userId
  const roomId = +req.query.roomid
  const lastTime = req.query.lasttime
  if (!roomId || !await existsChatRoom(userId, roomId)) {
    res.send({ status: 'Success', message: null, data: [] })
    // res.send({ status: 'Fail', message: 'Unknow room', data: null })
    return
  }
  const chats = await getChats(roomId, !lastTime ? null : parseInt(lastTime))

  const result = []
  chats.forEach((c) => {
    if (c.status !== Status.InversionDeleted) {
      result.push({
        dateTime: new Date(c.dateTime).toLocaleString(),
        text: c.prompt,
        inversion: true,
        error: false,
        conversationOptions: null,
        requestOptions: {
          prompt: c.prompt,
          options: null,
        },
      })
    }
    if (c.status !== Status.ResponseDeleted) {
      result.push({
        dateTime: new Date(c.dateTime).toLocaleString(),
        text: c.response,
        inversion: false,
        error: false,
        loading: false,
        conversationOptions: {
          parentMessageId: c.options.messageId,
        },
        requestOptions: {
          prompt: c.prompt,
          parentMessageId: c.options.parentMessageId,
        },
      })
    }
  })

  res.send({ status: 'Success', message: null, data: result })
})

router.post('/chat-delete', auth, async (req, res) => {
  const userId = req.headers.userId
  const { roomId, uuid, inversion } = req.body as { roomId: number; uuid: number; inversion: boolean }
  if (!roomId || !await existsChatRoom(userId, roomId)) {
    res.send({ status: 'Fail', message: 'Unknow room', data: null })
    return
  }
  await deleteChat(roomId, uuid, inversion)
  res.send({ status: 'Success', message: null, data: null })
})

router.post('/chat-clear', auth, async (req, res) => {
  const userId = req.headers.userId
  const { roomId } = req.body as { roomId: number }
  if (!roomId || !await existsChatRoom(userId, roomId)) {
    res.send({ status: 'Fail', message: 'Unknow room', data: null })
    return
  }
  await clearChat(roomId)
  res.send({ status: 'Success', message: null, data: null })
})

router.post('/chat', auth, async (req, res) => {
  try {
    const { roomId, uuid, regenerate, prompt, options = {} } = req.body as
      { roomId: number; uuid: number; regenerate: boolean; prompt: string; options?: ChatContext }
    const message = regenerate
      ? await getChat(roomId, uuid)
      : await insertChat(uuid, prompt, roomId, options as ChatOptions)
    const response = await chatReply(prompt, options)
    if (response.status === 'Success')
      await updateChat(message._id, response.data.text, response.data.id)
    res.send(response)
  }
  catch (error) {
    res.send(error)
  }
})

router.post('/chat-process', auth, async (req, res) => {
  res.setHeader('Content-type', 'application/octet-stream')

  try {
    const { roomId, uuid, regenerate, prompt, options = {} } = req.body as
      { roomId: number; uuid: number; regenerate: boolean; prompt: string; options?: ChatContext }
    const message = regenerate
      ? await getChat(roomId, uuid)
      : await insertChat(uuid, prompt, roomId, options as ChatOptions)
    let firstChunk = true
    const result = await chatReplyProcess(prompt, options, (chat: ChatMessage) => {
      res.write(firstChunk ? JSON.stringify(chat) : `\n${JSON.stringify(chat)}`)
      firstChunk = false
    })
    if (result.status === 'Success')
      await updateChat(message._id, result.data.text, result.data.id)
  }
  catch (error) {
    res.write(JSON.stringify(error))
  }
  finally {
    res.end()
  }
})

router.post('/user-register', async (req, res) => {
  const { username, password } = req.body as { username: string; password: string }
  const config = await getCacheConfig()
  if (!config.siteConfig.registerEnabled) {
    res.send({ status: 'Fail', message: '注册账号功能未启用 | Register account is disabled!', data: null })
    return
  }
  if (isNotEmptyString(config.siteConfig.registerMails)) {
    let allowSuffix = false
    const emailSuffixs = config.siteConfig.registerMails.split(',')
    for (let index = 0; index < emailSuffixs.length; index++) {
      const element = emailSuffixs[index]
      allowSuffix = username.toLowerCase().endsWith(element)
      if (allowSuffix)
        break
    }
    if (!allowSuffix) {
      res.send({ status: 'Fail', message: '该邮箱后缀不支持 | The email service provider is not allowed', data: null })
      return
    }
  }

  const user = await getUser(username)
  if (user != null) {
    res.send({ status: 'Fail', message: '邮箱已存在 | The email exists', data: null })
    return
  }
  const newPassword = md5(password)
  await createUser(username, newPassword)

  if (username.toLowerCase() === process.env.ROOT_USER) {
    res.send({ status: 'Success', message: '注册成功 | Register success', data: null })
  }
  else {
    await sendMail(username, await getUserVerifyUrl(username))
    res.send({ status: 'Success', message: '注册成功, 去邮箱中验证吧 | Registration is successful, you need to go to email verification', data: null })
  }
})

router.post('/config', auth, async (req, res) => {
  try {
    const userId = new ObjectId(req.headers.userId.toString())

    const user = await getUserById(userId)
    if (user == null || user.status !== Status.Normal || user.email.toLowerCase() !== process.env.ROOT_USER)
      throw new Error('无权限 | No permission.')

    const response = await chatConfig()
    res.send(response)
  }
  catch (error) {
    res.send(error)
  }
})

router.post('/session', async (req, res) => {
  try {
    const config = await getCacheConfig()
    const hasAuth = config.siteConfig.loginEnabled
    const allowRegister = (await getCacheConfig()).siteConfig.registerEnabled
    res.send({ status: 'Success', message: '', data: { auth: hasAuth, allowRegister, model: currentModel() } })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-login', async (req, res) => {
  try {
    const { username, password } = req.body as { username: string; password: string }
    if (!username || !password)
      throw new Error('用户名或密码为空 | Username or password is empty')

    const user = await getUser(username)
    if (user == null
      || user.status !== Status.Normal
      || user.password !== md5(password)) {
      if (user != null && user.status === Status.PreVerify)
        throw new Error('请去邮箱中验证 | Please verify in the mailbox')
      throw new Error('用户不存在或密码错误 | User does not exist or incorrect password.')
    }
    const config = await getCacheConfig()
    const token = jwt.sign({
      name: user.name ? user.name : user.email,
      avatar: user.avatar,
      description: user.description,
      userId: user._id,
      root: username.toLowerCase() === process.env.ROOT_USER,
    }, config.siteConfig.loginSalt.trim())
    res.send({ status: 'Success', message: '登录成功 | Login successfully', data: { token } })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-info', auth, async (req, res) => {
  try {
    const { name, avatar, description } = req.body as UserInfo
    const userId = new ObjectId(req.headers.userId.toString())

    const user = await getUserById(userId)
    if (user == null || user.status !== Status.Normal)
      throw new Error('用户不存在 | User does not exist.')
    await updateUserInfo(userId, { name, avatar, description } as UserInfo)
    res.send({ status: 'Success', message: '更新成功 | Update successfully' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body as { token: string }
    if (!token)
      throw new Error('Secret key is empty')
    const username = await checkUserVerify(token)
    await verifyUser(username)
    res.send({ status: 'Success', message: '验证成功 | Verify successfully', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/setting-base', auth, async (req, res) => {
  try {
    const { apiKey, apiModel, apiBaseUrl, accessToken, timeoutMs, socksProxy, httpsProxy } = req.body as Config
    const userId = new ObjectId(req.headers.userId.toString())

    if (apiKey == null && accessToken == null)
      throw new Error('Missing OPENAI_API_KEY or OPENAI_ACCESS_TOKEN environment variable.')

    const user = await getUserById(userId)
    if (user == null || user.status !== Status.Normal || user.email.toLowerCase() !== process.env.ROOT_USER)
      throw new Error('无权限 | No permission.')

    const thisConfig = await getOriginConfig()
    thisConfig.apiKey = apiKey
    thisConfig.apiModel = apiModel
    thisConfig.apiBaseUrl = apiBaseUrl
    thisConfig.accessToken = accessToken
    thisConfig.timeoutMs = timeoutMs
    thisConfig.socksProxy = socksProxy
    thisConfig.httpsProxy = httpsProxy
    await updateConfig(thisConfig)
    clearConfigCache()
    initApi()
    const response = await chatConfig()
    res.send({ status: 'Success', message: '操作成功 | Successfully', data: response.data })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/setting-site', auth, async (req, res) => {
  try {
    const config = req.body as SiteConfig
    const userId = new ObjectId(req.headers.userId.toString())

    const user = await getUserById(userId)
    if (user == null || user.status !== Status.Normal || user.email.toLowerCase() !== process.env.ROOT_USER)
      throw new Error('无权限 | No permission.')

    const thisConfig = await getOriginConfig()
    thisConfig.siteConfig = config
    const result = await updateConfig(thisConfig)
    clearConfigCache()
    res.send({ status: 'Success', message: '操作成功 | Successfully', data: result.siteConfig })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/setting-mail', auth, async (req, res) => {
  try {
    const config = req.body as MailConfig
    const userId = new ObjectId(req.headers.userId.toString())

    const user = await getUserById(userId)
    if (user == null || user.status !== Status.Normal || user.email.toLowerCase() !== process.env.ROOT_USER)
      throw new Error('无权限 | No permission.')

    const thisConfig = await getOriginConfig()
    thisConfig.mailConfig = config
    const result = await updateConfig(thisConfig)
    clearConfigCache()
    res.send({ status: 'Success', message: '操作成功 | Successfully', data: result.mailConfig })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

app.use('', router)
app.use('/api', router)

app.listen(3002, () => globalThis.console.log('Server is running on port 3002'))
