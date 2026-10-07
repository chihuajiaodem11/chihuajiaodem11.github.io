import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

type Theme = 'dark' | 'light'
type TimerMode = 'stopwatch' | 'pomodoro'
type PomoPhase = 'focus' | 'break'
type Priority = 'low' | 'medium' | 'high'
type TodoFilter = 'all' | 'active' | 'completed'

interface Todo {
  id: string
  title: string
  priority: Priority
  completed: boolean
  createdAt: number
  updatedAt: number
}

interface SessionRecord {
  id: string
  kind: TimerMode
  seconds: number
  label: string
  completedAt: number
}

interface DayStats {
  focusSeconds: number
  pomodoros: number
  sessions: SessionRecord[]
}

interface StopwatchState {
  elapsedSeconds: number
  running: boolean
  startedAt: number | null
  task: string
}

interface PomodoroState {
  phase: PomoPhase
  focusMinutes: number
  breakMinutes: number
  remainingSeconds: number
  running: boolean
  endAt: number | null
  task: string
  focusStartedAt: number | null
}

interface AppState {
  version: 1
  theme: Theme
  mode: TimerMode
  stopwatch: StopwatchState
  pomodoro: PomodoroState
  todos: Todo[]
  stats: Record<string, DayStats>
}

const STORAGE_KEY = 'focusboard-state-v1'
const CLOUD_TABLE = 'focusboard_data'
const POMODORO_PRESETS = [
  { label: '15 / 5', focus: 15, rest: 5 },
  { label: '25 / 5', focus: 25, rest: 5 },
  { label: '50 / 10', focus: 50, rest: 10 },
]

const createDayStats = (): DayStats => ({ focusSeconds: 0, pomodoros: 0, sessions: [] })

const dateKey = (timestamp = Date.now()) => {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const createDefaultState = (): AppState => ({
  version: 1,
  theme: 'dark',
  mode: 'stopwatch',
  stopwatch: { elapsedSeconds: 0, running: false, startedAt: null, task: '' },
  pomodoro: {
    phase: 'focus',
    focusMinutes: 25,
    breakMinutes: 5,
    remainingSeconds: 25 * 60,
    running: false,
    endAt: null,
    task: '',
    focusStartedAt: null,
  },
  todos: [],
  stats: {},
})

const normalizeState = (candidate: unknown): AppState => {
  const fallback = createDefaultState()
  if (!candidate || typeof candidate !== 'object') return fallback

  const raw = candidate as Partial<AppState>
  const rawStopwatch = raw.stopwatch ?? fallback.stopwatch
  const rawPomodoro = raw.pomodoro ?? fallback.pomodoro
  const rawTodos = Array.isArray(raw.todos) ? raw.todos : []
  const rawStats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {}

  return {
    ...fallback,
    theme: raw.theme === 'light' ? 'light' : 'dark',
    mode: raw.mode === 'pomodoro' ? 'pomodoro' : 'stopwatch',
    stopwatch: {
      elapsedSeconds: Number.isFinite(rawStopwatch.elapsedSeconds) ? Math.max(0, rawStopwatch.elapsedSeconds) : 0,
      running: rawStopwatch.running === true,
      startedAt: typeof rawStopwatch.startedAt === 'number' ? rawStopwatch.startedAt : null,
      task: typeof rawStopwatch.task === 'string' ? rawStopwatch.task : '',
    },
    pomodoro: {
      phase: rawPomodoro.phase === 'break' ? 'break' : 'focus',
      focusMinutes: clampMinutes(rawPomodoro.focusMinutes, 25),
      breakMinutes: clampMinutes(rawPomodoro.breakMinutes, 5),
      remainingSeconds: Number.isFinite(rawPomodoro.remainingSeconds)
        ? Math.max(0, rawPomodoro.remainingSeconds)
        : 25 * 60,
      running: rawPomodoro.running === true,
      endAt: typeof rawPomodoro.endAt === 'number' ? rawPomodoro.endAt : null,
      task: typeof rawPomodoro.task === 'string' ? rawPomodoro.task : '',
      focusStartedAt: typeof rawPomodoro.focusStartedAt === 'number' ? rawPomodoro.focusStartedAt : null,
    },
    todos: rawTodos
      .filter((todo): todo is Todo => Boolean(todo && typeof todo === 'object'))
      .map((todo) => {
        const priority: Priority = todo.priority === 'low' ? 'low' : todo.priority === 'high' ? 'high' : 'medium'
        return {
          id: typeof todo.id === 'string' ? todo.id : makeId(),
          title: typeof todo.title === 'string' ? todo.title : '',
          priority,
          completed: todo.completed === true,
          createdAt: typeof todo.createdAt === 'number' ? todo.createdAt : Date.now(),
          updatedAt: typeof todo.updatedAt === 'number' ? todo.updatedAt : Date.now(),
        }
      })
      .filter((todo) => todo.title.trim().length > 0),
    stats: Object.entries(rawStats).reduce<Record<string, DayStats>>((result, [key, value]) => {
      if (!value || typeof value !== 'object') return result
      const stats = value as Partial<DayStats>
      result[key] = {
        focusSeconds: typeof stats.focusSeconds === 'number' && Number.isFinite(stats.focusSeconds) ? Math.max(0, stats.focusSeconds) : 0,
        pomodoros: typeof stats.pomodoros === 'number' && Number.isFinite(stats.pomodoros) ? Math.max(0, stats.pomodoros) : 0,
        sessions: Array.isArray(stats.sessions)
          ? stats.sessions.filter((session): session is SessionRecord => Boolean(session && typeof session === 'object'))
          : [],
      }
      return result
    }, {}),
  }
}

const clampMinutes = (value: unknown, fallback: number) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(180, Math.max(1, Math.round(parsed)))
}

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const readState = (): AppState => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored ? normalizeState(JSON.parse(stored)) : createDefaultState()
  } catch {
    return createDefaultState()
  }
}

const hasMeaningfulData = (candidate: AppState) =>
  candidate.todos.length > 0 ||
  Object.keys(candidate.stats).length > 0 ||
  candidate.stopwatch.elapsedSeconds > 0 ||
  candidate.stopwatch.task.trim().length > 0 ||
  candidate.pomodoro.task.trim().length > 0 ||
  candidate.pomodoro.remainingSeconds !== candidate.pomodoro.focusMinutes * 60

const formatClock = (seconds: number, showHours = true) => {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remaining = safeSeconds % 60
  if (!showHours && hours === 0) return `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

const formatDuration = (seconds: number) => {
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`
}

const formatShortTime = (timestamp: number) =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp)

const formatToday = () =>
  new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(Date.now())

const priorityLabel: Record<Priority, string> = { low: '低', medium: '中', high: '高' }

const Icon = ({ name, size = 18 }: { name: string; size?: number }) => {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  const paths: Record<string, ReactNode> = {
    play: <path d="m9 6 9 6-9 6V6Z" />,
    pause: <><rect x="6.5" y="5" width="3.5" height="14" rx="1" /><rect x="14" y="5" width="3.5" height="14" rx="1" /></>,
    reset: <><path d="M4 12a8 8 0 1 0 2.35-5.65L4 8.7" /><path d="M4 4v4.7h4.7" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="m6 7 1 13h10l1-13" /><path d="M9 7V4h6v3" /></>,
    edit: <><path d="m4 16.5-.7 3.2 3.2-.7L18.8 6.7a2.1 2.1 0 0 0-3-3L4 16.5Z" /><path d="m14.5 5.5 4 4" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
    moon: <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    focus: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3" /><path d="M12 3.5V2M12 22v-1.5M3.5 12H2M22 12h-1.5" /></>,
    list: <><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
    trend: <><path d="M4 17 9 12l3 3 7-8" /><path d="M15 7h4v4" /></>,
    arrow: <path d="M5 12h13M13 6l6 6-6 6" />,
  }
  return <svg {...common}>{paths[name] ?? paths.focus}</svg>
}

const getElapsedSeconds = (timer: StopwatchState, now: number) =>
  timer.elapsedSeconds + (timer.running && timer.startedAt ? Math.floor((now - timer.startedAt) / 1000) : 0)

const getRemainingSeconds = (timer: PomodoroState, now: number) =>
  timer.running && timer.endAt ? Math.max(0, Math.ceil((timer.endAt - now) / 1000)) : timer.remainingSeconds

const addSessionToStats = (
  stats: Record<string, DayStats>,
  seconds: number,
  kind: TimerMode,
  label: string,
  completedAt: number,
): Record<string, DayStats> => {
  const key = dateKey(completedAt)
  const current = stats[key] ?? createDayStats()
  const session: SessionRecord = { id: makeId(), kind, seconds, label: label.trim() || '无标题专注', completedAt }
  return {
    ...stats,
    [key]: {
      focusSeconds: current.focusSeconds + seconds,
      pomodoros: current.pomodoros + (kind === 'pomodoro' ? 1 : 0),
      sessions: [...current.sessions, session].slice(-20),
    },
  }
}

const App = () => {
  const [state, setState] = useState<AppState>(() => readState())
  const [now, setNow] = useState(() => Date.now())
  const [todoFilter, setTodoFilter] = useState<TodoFilter>('all')
  const [todoDraft, setTodoDraft] = useState('')
  const [todoPriority, setTodoPriority] = useState<Priority>('medium')
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null)
  const [editingTodoTitle, setEditingTodoTitle] = useState('')
  const [customFocus, setCustomFocus] = useState(() => String(state.pomodoro.focusMinutes))
  const [customBreak, setCustomBreak] = useState(() => String(state.pomodoro.breakMinutes))
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [cloudHydrated, setCloudHydrated] = useState(false)
  const [cloudStatus, setCloudStatus] = useState<'checking' | 'signed-out' | 'syncing' | 'synced' | 'error'>('checking')
  const [authOpen, setAuthOpen] = useState(false)
  const [authStep, setAuthStep] = useState<'email' | 'code'>('email')
  const [authEmail, setAuthEmail] = useState('')
  const [authCode, setAuthCode] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const latestStateRef = useRef(state)
  const syncTimerRef = useRef<number | null>(null)

  useEffect(() => {
    latestStateRef.current = state
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    document.documentElement.style.colorScheme = state.theme
  }, [state])

  useEffect(() => {
    let active = true
    void supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      if (!active) return
      setSession(currentSession)
      setAuthReady(true)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return
      setSession(nextSession)
      setAuthReady(true)
      if (!nextSession) {
        setCloudHydrated(true)
        setCloudStatus('signed-out')
      }
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!authReady) return
    if (!session) {
      setCloudHydrated(true)
      setCloudStatus('signed-out')
      return
    }

    let cancelled = false
    setCloudHydrated(false)
    setCloudStatus('syncing')

    void (async () => {
      const { data: remoteRow, error } = await supabase
        .from(CLOUD_TABLE)
        .select('data')
        .eq('user_id', session.user.id)
        .maybeSingle()

      if (cancelled) return
      if (error) {
        setCloudStatus('error')
        setCloudHydrated(true)
        return
      }

      if (remoteRow?.data) {
        const remoteState = normalizeState(remoteRow.data)
        latestStateRef.current = remoteState
        setState(remoteState)
      } else if (hasMeaningfulData(latestStateRef.current)) {
        await supabase.from(CLOUD_TABLE).upsert({
          user_id: session.user.id,
          data: latestStateRef.current,
          updated_at: new Date().toISOString(),
        })
      }

      if (!cancelled) {
        setCloudHydrated(true)
        setCloudStatus('synced')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [authReady, session?.user.id])

  useEffect(() => {
    if (!authReady || !session || !cloudHydrated) return
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current)
    setCloudStatus('syncing')
    syncTimerRef.current = window.setTimeout(() => {
      void supabase.from(CLOUD_TABLE).upsert({
        user_id: session.user.id,
        data: state,
        updated_at: new Date().toISOString(),
      }).then(({ error }) => {
        setCloudStatus(error ? 'error' : 'synced')
      })
    }, 700)

    return () => {
      if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current)
    }
  }, [authReady, cloudHydrated, session?.user.id, state])

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    const pomodoro = state.pomodoro
    if (!pomodoro.running || !pomodoro.endAt || now < pomodoro.endAt) return

    setState((current) => {
      const active = current.pomodoro
      if (!active.running || !active.endAt || now < active.endAt) return current
      if (active.phase === 'focus') {
        const completedAt = now
        return {
          ...current,
          stats: addSessionToStats(current.stats, active.focusMinutes * 60, 'pomodoro', active.task, completedAt),
          pomodoro: {
            ...active,
            phase: 'break',
            running: true,
            endAt: completedAt + active.breakMinutes * 60 * 1000,
            remainingSeconds: active.breakMinutes * 60,
            focusStartedAt: null,
          },
        }
      }
      return {
        ...current,
        pomodoro: {
          ...active,
          phase: 'focus',
          running: false,
          endAt: null,
          remainingSeconds: active.focusMinutes * 60,
          focusStartedAt: null,
        },
      }
    })
  }, [now, state.pomodoro])

  const today = dateKey(now)
  const todayStats = state.stats[today] ?? createDayStats()
  const stopwatchSeconds = getElapsedSeconds(state.stopwatch, now)
  const pomodoroSeconds = getRemainingSeconds(state.pomodoro, now)
  const visibleTodos = useMemo(() => state.todos.filter((todo) => {
    if (todoFilter === 'active') return !todo.completed
    if (todoFilter === 'completed') return todo.completed
    return true
  }), [state.todos, todoFilter])
  const activeTodoCount = state.todos.filter((todo) => !todo.completed).length
  const completedTodoCount = state.todos.length - activeTodoCount
  const recentSessions = [...todayStats.sessions].reverse().slice(0, 4)

  const updateStopwatchTask = (task: string) => setState((current) => ({ ...current, stopwatch: { ...current.stopwatch, task } }))
  const updatePomodoroTask = (task: string) => setState((current) => ({ ...current, pomodoro: { ...current.pomodoro, task } }))

  const sendAuthCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const email = authEmail.trim()
    if (!email) {
      setAuthMessage('请先输入邮箱地址。')
      return
    }

    setAuthBusy(true)
    setAuthMessage('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    })
    setAuthBusy(false)

    if (error) {
      setAuthMessage(error.message)
      return
    }

    setAuthStep('code')
    setAuthMessage('验证码已发送，请检查邮箱。')
  }

  const verifyAuthCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const email = authEmail.trim()
    const token = authCode.trim().replace(/\s/g, '')
    if (!email || !token) {
      setAuthMessage('请输入邮箱和验证码。')
      return
    }

    setAuthBusy(true)
    setAuthMessage('')
    const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
    setAuthBusy(false)

    if (error) {
      setAuthMessage(error.message)
      return
    }

    setAuthOpen(false)
    setAuthStep('email')
    setAuthCode('')
    setAuthMessage('')
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setAuthOpen(false)
  }

  const startStopwatch = () => {
    const startedAt = Date.now()
    setNow(startedAt)
    setState((current) => {
      if (current.stopwatch.running) return current
      return { ...current, stopwatch: { ...current.stopwatch, running: true, startedAt } }
    })
  }

  const pauseStopwatch = () => {
    setState((current) => {
      if (!current.stopwatch.running) return current
      const elapsedSeconds = getElapsedSeconds(current.stopwatch, Date.now())
      return { ...current, stopwatch: { ...current.stopwatch, elapsedSeconds, running: false, startedAt: null } }
    })
  }

  const finishStopwatch = () => {
    setState((current) => {
      const elapsedSeconds = getElapsedSeconds(current.stopwatch, Date.now())
      if (elapsedSeconds < 1) return current
      return {
        ...current,
        stats: addSessionToStats(current.stats, elapsedSeconds, 'stopwatch', current.stopwatch.task, Date.now()),
        stopwatch: { ...current.stopwatch, elapsedSeconds: 0, running: false, startedAt: null },
      }
    })
  }

  const resetStopwatch = () => setState((current) => ({
    ...current,
    stopwatch: { ...current.stopwatch, elapsedSeconds: 0, running: false, startedAt: null },
  }))

  const startPomodoro = () => {
    const startedAt = Date.now()
    setNow(startedAt)
    setState((current) => {
      const pomodoro = current.pomodoro
      if (pomodoro.running) return current
      const duration = Math.max(1, pomodoro.remainingSeconds)
      return {
        ...current,
        pomodoro: {
          ...pomodoro,
          running: true,
          endAt: startedAt + duration * 1000,
          focusStartedAt: pomodoro.phase === 'focus' ? (pomodoro.focusStartedAt ?? startedAt) : pomodoro.focusStartedAt,
        },
      }
    })
  }

  const pausePomodoro = () => {
    setState((current) => {
      const pomodoro = current.pomodoro
      if (!pomodoro.running) return current
      return {
        ...current,
        pomodoro: {
          ...pomodoro,
          running: false,
          endAt: null,
          remainingSeconds: getRemainingSeconds(pomodoro, Date.now()),
        },
      }
    })
  }

  const resetPomodoro = () => setState((current) => ({
    ...current,
    pomodoro: {
      ...current.pomodoro,
      phase: 'focus',
      remainingSeconds: current.pomodoro.focusMinutes * 60,
      running: false,
      endAt: null,
      focusStartedAt: null,
    },
  }))

  const choosePreset = (focus: number, rest: number) => {
    setCustomFocus(String(focus))
    setCustomBreak(String(rest))
    setState((current) => ({
      ...current,
      pomodoro: {
        ...current.pomodoro,
        focusMinutes: focus,
        breakMinutes: rest,
        phase: 'focus',
        remainingSeconds: focus * 60,
        running: false,
        endAt: null,
        focusStartedAt: null,
      },
    }))
  }

  const applyCustomDurations = () => {
    const focus = clampMinutes(customFocus, state.pomodoro.focusMinutes)
    const rest = clampMinutes(customBreak, state.pomodoro.breakMinutes)
    setCustomFocus(String(focus))
    setCustomBreak(String(rest))
    setState((current) => ({
      ...current,
      pomodoro: {
        ...current.pomodoro,
        focusMinutes: focus,
        breakMinutes: rest,
        phase: 'focus',
        remainingSeconds: focus * 60,
        running: false,
        endAt: null,
        focusStartedAt: null,
      },
    }))
  }

  const submitTodo = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const title = todoDraft.trim()
    if (!title) return
    const createdAt = Date.now()
    setState((current) => ({
      ...current,
      todos: [{ id: makeId(), title, priority: todoPriority, completed: false, createdAt, updatedAt: createdAt }, ...current.todos],
    }))
    setTodoDraft('')
    setTodoPriority('medium')
  }

  const toggleTodo = (id: string) => setState((current) => ({
    ...current,
    todos: current.todos.map((todo) => todo.id === id ? { ...todo, completed: !todo.completed, updatedAt: Date.now() } : todo),
  }))

  const deleteTodo = (id: string) => setState((current) => ({ ...current, todos: current.todos.filter((todo) => todo.id !== id) }))

  const beginEditTodo = (todo: Todo) => {
    setEditingTodoId(todo.id)
    setEditingTodoTitle(todo.title)
  }

  const saveTodoEdit = () => {
    const title = editingTodoTitle.trim()
    if (!editingTodoId || !title) return
    setState((current) => ({
      ...current,
      todos: current.todos.map((todo) => todo.id === editingTodoId ? { ...todo, title, updatedAt: Date.now() } : todo),
    }))
    setEditingTodoId(null)
    setEditingTodoTitle('')
  }

  const cancelTodoEdit = () => {
    setEditingTodoId(null)
    setEditingTodoTitle('')
  }

  const toggleTheme = () => setState((current) => ({ ...current, theme: current.theme === 'dark' ? 'light' : 'dark' }))

  const isStopwatchRunning = state.stopwatch.running
  const isPomodoroRunning = state.pomodoro.running
  const activeModeLabel = state.mode === 'stopwatch' ? '正计时' : state.pomodoro.phase === 'focus' ? '专注中' : '休息中'
  const cloudStatusLabel = !authReady
    ? '连接中'
    : !session
      ? '仅本机'
      : cloudStatus === 'error'
        ? '同步异常'
        : cloudStatus === 'syncing'
          ? '同步中'
          : '已同步'

  return (
    <div className={`app-shell ${state.theme === 'light' ? 'theme-light' : 'theme-dark'}`}>
      <header className="topbar page-width">
        <div className="brand-lockup">
          <div className="brand-mark"><Icon name="focus" size={21} /></div>
          <div>
            <div className="brand-name">Focusboard</div>
            <div className="brand-caption">专注工作台</div>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="today-summary">
            <span>今日专注</span>
            <strong>{formatDuration(todayStats.focusSeconds)}</strong>
          </div>
          <div className="today-summary compact-summary">
            <span>番茄钟</span>
            <strong>{todayStats.pomodoros}<small> 个</small></strong>
          </div>
          <div className="auth-control">
            <button className={session ? 'sync-button connected' : 'sync-button'} type="button" onClick={() => setAuthOpen((open) => !open)}>
              <span className={`sync-dot ${session ? 'active' : ''}`} />{cloudStatusLabel}
            </button>
            {authOpen && <div className="auth-popover">
              {session ? (
                <>
                  <p className="auth-popover-title">云端同步已开启</p>
                  <p className="auth-popover-copy">{session.user.email}</p>
                  <p className="auth-popover-status"><span className={`sync-dot ${cloudStatus === 'error' ? 'error' : 'active'}`} />{cloudStatusLabel}</p>
                  <button className="text-action" type="button" onClick={signOut}>退出登录</button>
                </>
              ) : (
                <form className="auth-form" onSubmit={authStep === 'email' ? sendAuthCode : verifyAuthCode}>
                  <p className="auth-popover-title">邮箱验证码登录</p>
                  <p className="auth-popover-copy">登录后，待办、统计和计时状态会在设备间同步。</p>
                  <label>
                    <span>邮箱地址</span>
                    <input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" disabled={authStep === 'code'} />
                  </label>
                  {authStep === 'code' && <label>
                    <span>邮箱验证码</span>
                    <input inputMode="numeric" autoComplete="one-time-code" value={authCode} onChange={(event) => setAuthCode(event.target.value)} placeholder="输入验证码" maxLength={8} autoFocus />
                  </label>}
                  {authMessage && <p className="auth-message">{authMessage}</p>}
                  <button className="primary-button auth-submit" type="submit" disabled={authBusy}>{authBusy ? '处理中…' : authStep === 'email' ? '发送验证码' : '验证并同步'}</button>
                  {authStep === 'code' && <button className="text-action" type="button" onClick={() => { setAuthStep('email'); setAuthCode(''); setAuthMessage('') }}>更换邮箱</button>}
                </form>
              )}
            </div>}
          </div>
          <button className="icon-button" type="button" onClick={toggleTheme} aria-label="切换主题" title="切换主题">
            <Icon name={state.theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
        </div>
      </header>

      <main className="page-width page-content">
        <div className="page-intro">
          <div>
            <p className="eyebrow">{formatToday()}</p>
            <h1>把注意力放回眼前。</h1>
          </div>
          <p className="intro-note"><span className="status-dot" />{activeModeLabel}</p>
        </div>

        <div className="primary-grid">
          <section className={`panel timer-panel ${state.mode === 'pomodoro' && state.pomodoro.phase === 'break' ? 'break-state' : ''}`}>
            <div className="panel-header timer-header">
              <div className="mode-tabs" role="tablist" aria-label="计时器模式">
                <button className={state.mode === 'stopwatch' ? 'mode-tab active' : 'mode-tab'} type="button" role="tab" aria-selected={state.mode === 'stopwatch'} onClick={() => setState((current) => ({ ...current, mode: 'stopwatch' }))}>
                  正计时
                </button>
                <button className={state.mode === 'pomodoro' ? 'mode-tab active' : 'mode-tab'} type="button" role="tab" aria-selected={state.mode === 'pomodoro'} onClick={() => setState((current) => ({ ...current, mode: 'pomodoro' }))}>
                  番茄钟
                </button>
              </div>
              <span className="panel-kicker">{state.mode === 'stopwatch' ? '自由安排节奏' : `${state.pomodoro.focusMinutes} / ${state.pomodoro.breakMinutes} 分钟`}</span>
            </div>

            {state.mode === 'stopwatch' ? (
              <div className="timer-body">
                <div className="timer-status-line"><span className={`status-dot ${isStopwatchRunning ? 'active' : ''}`} />{isStopwatchRunning ? '专注进行中' : stopwatchSeconds > 0 ? '已暂停' : '准备开始'}</div>
                <div className="timer-display" aria-live="polite">{formatClock(stopwatchSeconds)}</div>
                <div className="timer-actions">
                  <button className="primary-button" type="button" onClick={isStopwatchRunning ? pauseStopwatch : startStopwatch}>
                    <Icon name={isStopwatchRunning ? 'pause' : 'play'} size={17} />{isStopwatchRunning ? '暂停' : stopwatchSeconds > 0 ? '继续' : '开始专注'}
                  </button>
                  <button className="secondary-button" type="button" onClick={finishStopwatch} disabled={stopwatchSeconds < 1}>
                    <Icon name="check" size={17} />完成本次
                  </button>
                  <button className="ghost-button" type="button" onClick={resetStopwatch} disabled={stopwatchSeconds < 1 && !isStopwatchRunning} aria-label="重置正计时" title="重置">
                    <Icon name="reset" size={17} />
                  </button>
                </div>
                <label className="task-field">
                  <span>当前专注内容</span>
                  <input value={state.stopwatch.task} onChange={(event) => updateStopwatchTask(event.target.value)} placeholder="例如：整理项目结构、阅读报告……" />
                </label>
              </div>
            ) : (
              <div className="timer-body">
                <div className="pomo-state-row">
                  <div className="timer-status-line"><span className={`status-dot ${isPomodoroRunning ? 'active' : ''}`} />{state.pomodoro.phase === 'focus' ? (isPomodoroRunning ? '专注进行中' : pomodoroSeconds < state.pomodoro.focusMinutes * 60 ? '已暂停' : '准备开始') : (isPomodoroRunning ? '休息中' : '休息结束')}</div>
                  {state.pomodoro.phase === 'break' && <span className="break-badge">休息时间</span>}
                </div>
                <div className="timer-display" aria-live="polite">{formatClock(pomodoroSeconds, false)}</div>
                <div className="timer-actions">
                  <button className="primary-button" type="button" onClick={isPomodoroRunning ? pausePomodoro : startPomodoro}>
                    <Icon name={isPomodoroRunning ? 'pause' : 'play'} size={17} />{isPomodoroRunning ? '暂停' : pomodoroSeconds < (state.pomodoro.phase === 'focus' ? state.pomodoro.focusMinutes * 60 : state.pomodoro.breakMinutes * 60) ? '继续' : '开始专注'}
                  </button>
                  <button className="ghost-button reset-with-label" type="button" onClick={resetPomodoro}>
                    <Icon name="reset" size={17} />重置
                  </button>
                </div>
                <label className="task-field">
                  <span>{state.pomodoro.phase === 'focus' ? '当前专注内容' : '下一段专注内容'}</span>
                  <input value={state.pomodoro.task} onChange={(event) => updatePomodoroTask(event.target.value)} placeholder="给这一段时间一个清晰目标" />
                </label>
                <div className="duration-controls">
                  <div className="duration-heading"><span>专注 / 休息</span><span className="muted-label">分钟</span></div>
                  <div className="preset-row">
                    {POMODORO_PRESETS.map((preset) => {
                      const selected = state.pomodoro.focusMinutes === preset.focus && state.pomodoro.breakMinutes === preset.rest
                      return <button key={preset.label} className={selected ? 'preset-button selected' : 'preset-button'} type="button" onClick={() => choosePreset(preset.focus, preset.rest)} disabled={isPomodoroRunning}>{preset.label}</button>
                    })}
                    <span className="custom-label">自定义</span>
                    <input className="duration-input" type="number" min="1" max="180" value={customFocus} onChange={(event) => setCustomFocus(event.target.value)} disabled={isPomodoroRunning} aria-label="自定义专注分钟数" />
                    <span className="slash">/</span>
                    <input className="duration-input" type="number" min="1" max="180" value={customBreak} onChange={(event) => setCustomBreak(event.target.value)} disabled={isPomodoroRunning} aria-label="自定义休息分钟数" />
                    <button className="apply-button" type="button" onClick={applyCustomDurations} disabled={isPomodoroRunning}>应用</button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="panel todo-panel">
            <div className="panel-header">
              <div>
                <p className="section-label">行动清单</p>
                <h2>待办事项</h2>
              </div>
              <span className="count-badge">{activeTodoCount} 项待办</span>
            </div>
            <form className="todo-form" onSubmit={submitTodo}>
              <input value={todoDraft} onChange={(event) => setTodoDraft(event.target.value)} placeholder="添加一件要完成的事" aria-label="新的待办事项" />
              <div className="todo-form-row">
                <select value={todoPriority} onChange={(event) => setTodoPriority(event.target.value as Priority)} aria-label="待办优先级">
                  <option value="low">低优先级</option>
                  <option value="medium">中优先级</option>
                  <option value="high">高优先级</option>
                </select>
                <button className="add-button" type="submit"><Icon name="plus" size={17} />添加</button>
              </div>
            </form>
            <div className="todo-filters" role="tablist" aria-label="待办筛选">
              {([['all', `全部 ${state.todos.length}`], ['active', `未完成 ${activeTodoCount}`], ['completed', `已完成 ${completedTodoCount}`]] as [TodoFilter, string][]).map(([filter, label]) => (
                <button key={filter} type="button" role="tab" aria-selected={todoFilter === filter} className={todoFilter === filter ? 'filter-button active' : 'filter-button'} onClick={() => setTodoFilter(filter)}>{label}</button>
              ))}
            </div>
            <div className="todo-list">
              {visibleTodos.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon"><Icon name="list" size={20} /></div>
                  <strong>{state.todos.length === 0 ? '还没有待办事项' : '这个筛选下暂无事项'}</strong>
                  <span>{state.todos.length === 0 ? '把下一件具体的事写下来，开始今天的节奏。' : '换一个筛选，或添加一件新的待办。'}</span>
                </div>
              ) : visibleTodos.map((todo) => (
                <div className={`todo-item ${todo.completed ? 'completed' : ''}`} key={todo.id}>
                  <button type="button" className={`todo-check ${todo.completed ? 'checked' : ''}`} onClick={() => toggleTodo(todo.id)} aria-label={todo.completed ? `标记${todo.title}为未完成` : `完成${todo.title}`}>
                    {todo.completed && <Icon name="check" size={13} />}
                  </button>
                  {editingTodoId === todo.id ? (
                    <div className="todo-edit-row">
                      <input value={editingTodoTitle} onChange={(event) => setEditingTodoTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveTodoEdit(); if (event.key === 'Escape') cancelTodoEdit() }} autoFocus aria-label="编辑待办事项" />
                      <button className="text-action save" type="button" onClick={saveTodoEdit}>保存</button>
                      <button className="text-action" type="button" onClick={cancelTodoEdit}>取消</button>
                    </div>
                  ) : (
                    <div className="todo-copy">
                      <span className="todo-title">{todo.title}</span>
                      <span className={`priority-pill ${todo.priority}`}>{priorityLabel[todo.priority]}优先级</span>
                    </div>
                  )}
                  {editingTodoId !== todo.id && <div className="todo-actions">
                    <button type="button" className="small-icon-button" onClick={() => beginEditTodo(todo)} aria-label={`编辑${todo.title}`} title="编辑"><Icon name="edit" size={15} /></button>
                    <button type="button" className="small-icon-button danger" onClick={() => deleteTodo(todo.id)} aria-label={`删除${todo.title}`} title="删除"><Icon name="trash" size={15} /></button>
                  </div>}
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="panel stats-panel">
          <div className="panel-header stats-header">
            <div>
              <p className="section-label">今天的进度</p>
              <h2>专注统计</h2>
            </div>
            <span className="panel-kicker">{session ? `已登录 · ${cloudStatusLabel}` : '未登录 · 仅保存在当前设备'}</span>
          </div>
          <div className="stats-layout">
            <div className="stat-cards">
              <div className="stat-card primary-stat"><div className="stat-card-top"><span>累计专注</span><Icon name="focus" size={16} /></div><strong>{formatClock(todayStats.focusSeconds, false)}</strong><small>{formatDuration(todayStats.focusSeconds)}</small></div>
              <div className="stat-card"><div className="stat-card-top"><span>完成番茄钟</span><Icon name="trend" size={16} /></div><strong>{todayStats.pomodoros}</strong><small>个完整专注段</small></div>
              <div className="stat-card"><div className="stat-card-top"><span>待办完成</span><Icon name="check" size={16} /></div><strong>{completedTodoCount}</strong><small>共 {state.todos.length} 项</small></div>
            </div>
            <div className="timeline-card">
              <div className="timeline-heading"><span>专注记录</span><span>{recentSessions.length ? `最近 ${recentSessions.length} 次` : '完成后显示'}</span></div>
              {recentSessions.length === 0 ? <div className="timeline-empty">完成一段专注后，这里会留下今天的节奏。</div> : <div className="timeline-list">
                {recentSessions.map((session) => <div className="timeline-item" key={session.id}><span className={`timeline-dot ${session.kind}`} /><div className="timeline-copy"><strong>{session.label}</strong><span>{session.kind === 'pomodoro' ? '番茄钟' : '正计时'} · {formatShortTime(session.completedAt)}</span></div><b>{formatDuration(session.seconds)}</b></div>)}
              </div>}
            </div>
          </div>
        </section>

        <footer className="page-footer"><span>Focusboard</span><span>专注发生在一段不被打扰的时间里。</span></footer>
      </main>
    </div>
  )
}

export default App
