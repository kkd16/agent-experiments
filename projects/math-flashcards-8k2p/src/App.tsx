import { useState, useEffect, useRef } from 'react';
import './App.css';

type Operation = '+' | '-' | '*' | '/';
type Difficulty = 'easy' | 'medium' | 'hard';

function generateRandomProblem(difficulty: Difficulty) {
  const ops: Operation[] = ['+', '-', '*', '/'];
  const selectedOp = ops[Math.floor(Math.random() * ops.length)] as Operation;

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

function App() {
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [operation, setOperation] = useState<Operation>('+');
  const [num1, setNum1] = useState<number>(0);
  const [num2, setNum2] = useState<number>(0);

  const [userAnswer, setUserAnswer] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [score, setScore] = useState<number>(0);

  const [streak, setStreak] = useState<number>(0);
  const [highScore, setHighScore] = useState<number>(getInitialHighScore());

  const [isSpeedRunActive, setIsSpeedRunActive] = useState<boolean>(false);
  const [timeLeft, setTimeLeft] = useState<number>(60);

  const inputRef = useRef<HTMLInputElement>(null);

  // Initialize first problem safely
  useEffect(() => {
    setTimeout(() => {
      const { n1, n2, selectedOp } = generateRandomProblem(difficulty);
      setNum1(n1);
      setNum2(n2);
      setOperation(selectedOp);
      setUserAnswer('');
      setMessage('');
    }, 0);
  }, [difficulty]);

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
        setMessage(`Time's up! Final Score: ${scoreRef.current}`);
      }, 0);
    }
    return () => clearInterval(timerId);
  }, [isSpeedRunActive, timeLeft]);

  const generateProblem = () => {
    const { n1, n2, selectedOp } = generateRandomProblem(difficulty);
    setNum1(n1);
    setNum2(n2);
    setOperation(selectedOp);
    setUserAnswer('');
    if (!isSpeedRunActive || timeLeft > 0) {
      setMessage('');
    }
    inputRef.current?.focus();
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

  const startSpeedRun = () => {
    setScore(0);
    setStreak(0);
    setTimeLeft(60);
    setIsSpeedRunActive(true);
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

    if (answer === correctAnswer) {
      setMessage("Correct!");
      const newScore = score + 1;
      setScore(newScore);
      setStreak(s => s + 1);
      updateHighScore(newScore);

      setTimeout(() => {
        generateProblem();
      }, 500); // Shorter timeout for faster gameplay
    } else {
      setMessage(`Incorrect. Try again!`);
      setStreak(0); // Reset streak
      setUserAnswer('');
      inputRef.current?.focus();
    }
  };

  return (
    <div className="app-container">
      <h1>Math Flashcards</h1>

      <div className="header-stats">
        <div className="stat">Score: {score}</div>
        <div className="stat">Streak: {streak} 🔥</div>
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

        <div className="speed-run-controls">
          {isSpeedRunActive ? (
            <div className="timer">Time Left: {timeLeft}s</div>
          ) : (
            <button type="button" onClick={startSpeedRun} className="speed-run-button">Start Speed Run (60s)</button>
          )}
        </div>
      </div>

      <div className="flashcard">
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
    </div>
  );
}

export default App;
