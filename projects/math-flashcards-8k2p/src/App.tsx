import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

type Operation = '+' | '-' | '*' | '/';
type Difficulty = 'easy' | 'medium' | 'hard';

type HistoryItem = {
  num1: number;
  num2: number;
  operation: Operation;
  userAnswer: string;
  correctAnswer: number;
  isCorrect: boolean;
};


function generateRandomProblem(difficulty: Difficulty, allowedOps: Operation[]) {
  const ops = allowedOps.length > 0 ? allowedOps : ['+'] as Operation[];
  const selectedOp = ops[Math.floor(Math.random() * ops.length)];

  let maxNum = 12;
  if (difficulty === 'medium') maxNum = 50;
  if (difficulty === 'hard') maxNum = 100;

  let n1 = Math.floor(Math.random() * maxNum) + 1;
  let n2 = Math.floor(Math.random() * maxNum) + 1;

  if (selectedOp === '-') {
    if (n2 > n1) {
      [n1, n2] = [n2, n1];
    }
  } else if (selectedOp === '/') {
    // Ensure integer division
    const result = Math.floor(Math.random() * maxNum) + 1;
    const divisor = Math.floor(Math.random() * (maxNum > 12 ? 12 : maxNum)) + 1;
    n1 = result * divisor;
    n2 = divisor;
  }

  return { n1, n2, selectedOp };
}

function getInitialHighScore() {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsHighScore');
    if (stored) return parseInt(stored, 10);
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return 0;
}


function getInitialTheme(): 'light' | 'dark' {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsTheme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return 'light';
}


function getInitialStreak(): number {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsStreak');
    if (stored) return parseInt(stored, 10);
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return 0;
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme());
  const [allowedOperations, setAllowedOperations] = useState<Operation[]>(['+', '-', '*', '/']);
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [operation, setOperation] = useState<Operation>('+');
  const [num1, setNum1] = useState<number>(0);
  const [num2, setNum2] = useState<number>(0);

  const [userAnswer, setUserAnswer] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [score, setScore] = useState<number>(0);

  const [streak, setStreak] = useState<number>(getInitialStreak());
  const [highScore, setHighScore] = useState<number>(getInitialHighScore());

  const [isSpeedRunActive, setIsSpeedRunActive] = useState<boolean>(false);
  const [timeLeft, setTimeLeft] = useState<number>(60);
  const [selectedTimerDuration, setSelectedTimerDuration] = useState<number>(60);
  const [questionsAnswered, setQuestionsAnswered] = useState<number>(0);
  const [showSummary, setShowSummary] = useState<boolean>(false);
  const [animationClass, setAnimationClass] = useState<string>('');
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);

  // Initialize first problem safely
  useEffect(() => {
    setTimeout(() => {
      const { n1, n2, selectedOp } = generateRandomProblem(difficulty, allowedOperations);
      setNum1(n1);
      setNum2(n2);
      setOperation(selectedOp);
      setUserAnswer('');
      setMessage('');
    }, 0);
  }, [difficulty, allowedOperations]);


  const scoreRef = useRef(score);
  useEffect(() => {
    scoreRef.current = score;
  }, [score]);

  useEffect(() => {
    let timerId: ReturnType<typeof setInterval>;
    if (isSpeedRunActive && timeLeft > 0) {
      timerId = setInterval(() => {
        setTimeLeft(t => t - 1);
      }, 1000);
    } else if (isSpeedRunActive && timeLeft === 0) {
      setTimeout(() => {
        setIsSpeedRunActive(false);
        setShowSummary(true);
      }, 0);
    }
    return () => clearInterval(timerId);
  }, [isSpeedRunActive, timeLeft]);

  const generateProblem = useCallback(() => {
    const { n1, n2, selectedOp } = generateRandomProblem(difficulty, allowedOperations);
    setNum1(n1);
    setNum2(n2);
    setOperation(selectedOp);
    setUserAnswer('');
    if (!isSpeedRunActive || timeLeft > 0) {
      setMessage('');
    }
    inputRef.current?.focus();
  }, [difficulty, isSpeedRunActive, timeLeft, allowedOperations]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'n' || e.key === 'N') {
        if (!isSpeedRunActive || timeLeft > 0) {
          generateProblem();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSpeedRunActive, timeLeft, generateProblem]);


  const updateStreak = (newStreak: number) => {
    setStreak(newStreak);
    try {
      window.localStorage.setItem('mathFlashcardsStreak', newStreak.toString());
    } catch (e) {
      console.error("Local storage error:", e);
    }
  };

  const updateHighScore = (newScore: number) => {
    if (newScore > highScore) {
      setHighScore(newScore);
      try {
        window.localStorage.setItem('mathFlashcardsHighScore', newScore.toString());
      } catch (e) {
        console.error("Local storage error:", e);
      }
    }
  };


  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    try {
      window.localStorage.setItem('mathFlashcardsTheme', newTheme);
    } catch (e) {
      console.error("Local storage error:", e);
    }
  };

  const startSpeedRun = () => {
    setScore(0);
    updateStreak(0);
    setTimeLeft(selectedTimerDuration);
    setQuestionsAnswered(0);
    setHistory([]);
    setIsSpeedRunActive(true);
    setShowSummary(false);
    setMessage('');
    generateProblem();
  };

  const checkAnswer = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSpeedRunActive && timeLeft === 0) return;

    const answer = parseInt(userAnswer, 10);
    if (isNaN(answer)) {
      setMessage("Please enter a valid number.");
      return;
    }

    let correctAnswer = 0;
    switch (operation) {
      case '+': correctAnswer = num1 + num2; break;
      case '-': correctAnswer = num1 - num2; break;
      case '*': correctAnswer = num1 * num2; break;
      case '/': correctAnswer = num1 / num2; break;
    }


    const isCorrect = answer === correctAnswer;
    setHistory(prev => [...prev, {
      num1, num2, operation, userAnswer, correctAnswer, isCorrect
    }]);

    if (isCorrect) {
      setMessage("Correct!");
      setAnimationClass('flash-correct');
      setTimeout(() => setAnimationClass(''), 500);

      let points = 1;
      if (streak >= 10) points = 3;
      else if (streak >= 5) points = 2;

      const newScore = score + points;
      setScore(newScore);
      updateStreak(streak + 1);
      updateHighScore(newScore);
      setQuestionsAnswered(prev => prev + 1);

      setTimeout(() => {
        generateProblem();
      }, 500); // Shorter timeout for faster gameplay

    } else {
      setMessage(`Incorrect. Try again!`);
      setAnimationClass('flash-incorrect');
      setTimeout(() => setAnimationClass(''), 500);
      updateStreak(0); // Reset streak
      setUserAnswer('');
      inputRef.current?.focus();
    }
  };

  return (
    <div className={`app-wrapper ${theme}`}>
    <div className={`app-container ${theme}`}>
      <div className="header-top">
        <h1>Math Flashcards</h1>
        <button onClick={toggleTheme} className="theme-toggle">
          {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
        </button>
      </div>


      <div className="header-stats">
        <div className="stat">Score: {score}</div>
        <div className="stat">
          Streak: {streak} 🔥
          {streak >= 10 ? ' (x3)' : (streak >= 5 ? ' (x2)' : '')}
        </div>
        <div className="stat">High Score: {highScore}</div>
      </div>


      <div className="controls">
        <div className="difficulty-selector">
          <label htmlFor="difficulty">Difficulty:</label>
          <select
            id="difficulty"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
            disabled={isSpeedRunActive}
          >
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </div>

        <div className="operations-selector">
          <span>Operations:</span>
          {(['+', '-', '*', '/'] as Operation[]).map(op => (
            <label key={op} className="op-label">
              <input
                type="checkbox"
                checked={allowedOperations.includes(op)}
                disabled={isSpeedRunActive || (allowedOperations.length === 1 && allowedOperations.includes(op))}
                onChange={(e) => {
                  if (e.target.checked) {
                    setAllowedOperations([...allowedOperations, op]);
                  } else {
                    setAllowedOperations(allowedOperations.filter(o => o !== op));
                  }
                }}
              />
              {op}
            </label>
          ))}
        </div>

        <div className="speed-run-controls">

          {isSpeedRunActive ? (
            <div className="progress-container">
              <div className="progress-bar" style={{ width: `${(timeLeft / selectedTimerDuration) * 100}%` }}></div>
              <div className="progress-text">{timeLeft}s</div>
            </div>
          ) : (

            <div className="timer-select-container" style={{display: 'flex', gap: '0.5rem', alignItems: 'center'}}>
              <select value={selectedTimerDuration} onChange={(e) => setSelectedTimerDuration(parseInt(e.target.value, 10))} className="timer-select">
                <option value={30}>30s</option>
                <option value={60}>60s</option>
                <option value={120}>120s</option>
              </select>
              <button type="button" onClick={startSpeedRun} className="speed-run-button">Start Speed Run</button>
            </div>
          )}
        </div>
      </div>

      <div className={`flashcard ${animationClass}`}>
        <div className="problem">
          <span className="number">{num1}</span>
          <span className="operation">{operation}</span>
          <span className="number">{num2}</span>
        </div>
        <form onSubmit={checkAnswer} className="answer-form">
          <input
            ref={inputRef}
            type="number"
            value={userAnswer}
            onChange={(e) => setUserAnswer(e.target.value)}
            autoFocus
            className="answer-input"
            placeholder="?"
            disabled={isSpeedRunActive && timeLeft === 0}
          />
          <button type="submit" className="submit-button" disabled={isSpeedRunActive && timeLeft === 0}>Check</button>
        </form>
      </div>

      {message && <div className={`message ${message === 'Correct!' ? 'success' : (message.includes('Time') ? 'info' : 'error')}`}>{message}</div>}

      <button type="button" onClick={generateProblem} className="next-button" disabled={isSpeedRunActive && timeLeft === 0}>Skip / Next Problem</button>

      {showSummary && (
        <div className="summary-modal-overlay">
          <div className="summary-modal">
            <h2>Time's Up!</h2>
            <p>Final Score: <strong>{score}</strong></p>
            <p>High Score: <strong>{highScore}</strong></p>
            <p>Questions Answered: <strong>{questionsAnswered}</strong></p>
            <p>Average Time: <strong>{questionsAnswered > 0 ? (selectedTimerDuration / questionsAnswered).toFixed(2) : 0}s</strong></p>

            <div className="history-container">
              <h3>History</h3>
              <ul className="history-list">
                {history.map((item, index) => (
                  <li key={index} className={item.isCorrect ? 'history-correct' : 'history-incorrect'}>
                    {item.num1} {item.operation} {item.num2} = {item.userAnswer}
                    {!item.isCorrect && <span> (Correct: {item.correctAnswer})</span>}
                  </li>
                ))}
              </ul>
            </div>

            <div style={{marginTop: '1.5rem'}}>
              <button onClick={() => setShowSummary(false)} className="submit-button">Close</button>
              <button onClick={startSpeedRun} className="speed-run-button" style={{marginLeft: '1rem'}}>Play Again</button>
            </div>
          </div>
        </div>
      )}

    </div>
    </div>
  );
}

export default App;
