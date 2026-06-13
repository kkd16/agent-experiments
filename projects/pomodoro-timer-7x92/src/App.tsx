import { useState, useEffect } from 'react'
import './App.css'

const WORK_MINUTES = 25
const BREAK_MINUTES = 5

export default function App() {
  const [timeLeft, setTimeLeft] = useState(WORK_MINUTES * 60)
  const [isRunning, setIsRunning] = useState(false)
  const [mode, setMode] = useState<'work' | 'break'>('work')

  useEffect(() => {
    let intervalId: number | undefined

    if (isRunning) {
      intervalId = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            setIsRunning(false)

            // Auto-switch mode without second useEffect
            setMode((prevMode) => {
              const nextMode = prevMode === 'work' ? 'break' : 'work'
              // Timeout here to decouple the state update slightly, preventing cascading render warnings
              setTimeout(() => {
                setTimeLeft(nextMode === 'work' ? WORK_MINUTES * 60 : BREAK_MINUTES * 60)
              }, 0)
              return nextMode
            })

            return 0
          }
          return prev - 1
        })
      }, 1000)
    }

    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [isRunning])

  const toggleTimer = () => setIsRunning(!isRunning)

  const resetTimer = () => {
    setIsRunning(false)
    setTimeLeft(mode === 'work' ? WORK_MINUTES * 60 : BREAK_MINUTES * 60)
  }

  const switchMode = (newMode: 'work' | 'break') => {
    setMode(newMode)
    setIsRunning(false)
    setTimeLeft(newMode === 'work' ? WORK_MINUTES * 60 : BREAK_MINUTES * 60)
  }

  // UI display values
  const minutes = Math.floor(timeLeft / 60)
  const seconds = timeLeft % 60
  const displayTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`

  return (
    <main className="app">
      <div className="card">
        <h1>Pomodoro Timer</h1>
        <div className="mode-indicator">
          {mode === 'work' ? 'Work Time' : 'Break Time'}
        </div>

        <div className="timer-display">
          {displayTime}
        </div>

        <div className="controls">
          {!isRunning ? (
            <button onClick={toggleTimer}>Start</button>
          ) : (
            <button onClick={toggleTimer}>Pause</button>
          )}
          <button onClick={resetTimer} className="reset-btn">Reset</button>
        </div>

        <div className="mode-switches">
          <button
            className={`mode-btn ${mode === 'work' ? 'active' : ''}`}
            onClick={() => switchMode('work')}
          >
            Work
          </button>
          <button
            className={`mode-btn ${mode === 'break' ? 'active' : ''}`}
            onClick={() => switchMode('break')}
          >
            Break
          </button>
        </div>
      </div>
    </main>
  )
}
