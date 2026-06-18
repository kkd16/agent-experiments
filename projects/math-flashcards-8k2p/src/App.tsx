import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

type Operation = '+' | '-' | '*' | '/';
type Difficulty = 'easy' | 'medium' | 'hard';


type RunScore = {
  score: number;
  date: number;
};

type HistoryItem = {
  num1: number;
  num2: number;
  operation: Operation;
  userAnswer: string;
  correctAnswer: number;
  isCorrect: boolean;
};


function generateRandomProblem(difficulty: Difficulty, allowedOps: Operation[], allowNegativesParam: boolean = false) {
  const ops = allowedOps.length > 0 ? allowedOps : ['+'] as Operation[];
  const selectedOp = ops[Math.floor(Math.random() * ops.length)];

  let maxNum = 12;
  if (difficulty === 'medium') maxNum = 50;
  if (difficulty === 'hard') maxNum = 100;

  let n1 = Math.floor(Math.random() * maxNum) + 1;
  let n2 = Math.floor(Math.random() * maxNum) + 1;

  if (selectedOp === '-') {
    if (!allowNegativesParam && n2 > n1) {
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




function getInitialHideTimer(): boolean {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsHideTimer');
    if (stored !== null) return stored === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return false;
}

function getInitialEnableShake(): boolean {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsEnableShake');
    if (stored !== null) return stored === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return true;
}

function getInitialAllowNegatives(): boolean {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsAllowNegatives');
    if (stored !== null) return stored === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return false;
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



function getInitialZenMode(): boolean {
  try {
    const item = window.localStorage.getItem('mathFlashcardsZenMode');
    return item ? item === 'true' : false;
  } catch (e) {
    console.error(e);
    return false;
  }
}


function getInitialMaxCombo(): number {
  try {
    const item = window.localStorage.getItem('mathFlashcardsMaxCombo');
    return item ? parseInt(item, 10) : 3;
  } catch (e) {
    console.error(e);
    return 3;
  }
}


function getInitialFontSize(): 'normal' | 'large' | 'extra-large' {
  try {
    const item = window.localStorage.getItem('mathFlashcardsFontSize');
    return (item === 'large' || item === 'extra-large') ? item : 'normal';
  } catch (e) {
    console.error(e);
    return 'normal';
  }
}


function getInitialBestCombo(): number {
  try {
    const item = window.localStorage.getItem('mathFlashcardsBestCombo');
    return item ? parseInt(item, 10) : 0;
  } catch (e) {
    console.error(e);
    return 0;
  }
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



function getInitialNumpadLayout(): 'phone' | 'calculator' {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsNumpadLayout');
    if (stored === 'phone' || stored === 'calculator') return stored;
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return 'phone';
}

function getInitialRunScores(): RunScore[] {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsRunScores');
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return [];
}

function getInitialLifetimeQuestions(): number {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsLifetimeQuestions');
    if (stored) return parseInt(stored, 10);
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return 0;
}


function playSound(type: 'correct' | 'incorrect') {
  try {
    const AudioContextClass = window.AudioContext || ((window as unknown) as { webkitAudioContext: typeof window.AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    if (type === 'correct') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
      gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
      setTimeout(() => ctx.close().catch(() => {}), 150);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.2);
      gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
      setTimeout(() => ctx.close().catch(() => {}), 250);
    }
  } catch (e) {
    console.error("Audio playback failed", e);
  }
}


const STREAK_MESSAGES = [
  "On Fire! 🔥",
  "Unstoppable! 🚀",
  "Math Genius! 🧠",
  "Incredible! ⭐",
  "Godlike! ⚡"
];

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme());

  const [zenMode, setZenMode] = useState<boolean>(getInitialZenMode());

  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsZenMode', zenMode.toString());
    } catch (e) {
      console.error(e);
    }
  }, [zenMode]);

  const [allowedOperations, setAllowedOperations] = useState<Operation[]>(['+', '-', '*', '/']);
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [flashcardSize, setFlashcardSize] = useState<'small' | 'medium' | 'large'>('medium');
  const [accessibilityFontSize, setAccessibilityFontSize] = useState<'normal' | 'large' | 'extra-large'>(getInitialFontSize());

  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsFontSize', accessibilityFontSize);
    } catch (e) {
      console.error(e);
    }
  }, [accessibilityFontSize]);

  const [operation, setOperation] = useState<Operation>('+');
  const [num1, setNum1] = useState<number>(0);
  const [num2, setNum2] = useState<number>(0);

  const [userAnswer, setUserAnswer] = useState<string>('');
  const [answerStatus, setAnswerStatus] = useState<'correct' | 'incorrect' | null>(null);
  const [showConfetti, setShowConfetti] = useState<boolean>(false);
  const [confettiPieces, setConfettiPieces] = useState<Array<{left: string, delay: string, color: string}>>([]);



  const [message, setMessage] = useState<string>('');
  const [score, setScore] = useState<number>(0);
  const [scoreBump, setScoreBump] = useState<boolean>(false);

  const [streak, setStreak] = useState<number>(getInitialStreak());
  const [highScore, setHighScore] = useState<number>(getInitialHighScore());
  const [bestHistoricalCombo, setBestHistoricalCombo] = useState<number>(getInitialBestCombo());

  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsBestCombo', bestHistoricalCombo.toString());
    } catch (e) {
      console.error(e);
    }
  }, [bestHistoricalCombo]);


  const [isSpeedRunActive, setIsSpeedRunActive] = useState<boolean>(false);
  const [gameMode, setGameMode] = useState<'time' | 'questions' | 'endless' | 'timeAttack'>('time');
  const [maxComboMultiplier, setMaxComboMultiplier] = useState<number>(getInitialMaxCombo());

  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsMaxCombo', maxComboMultiplier.toString());
    } catch (e) {
      console.error(e);
    }
  }, [maxComboMultiplier]);

  const [isSuddenDeathMode, setIsSuddenDeathMode] = useState<boolean>(false);
  const [isHardcoreMode, setIsHardcoreMode] = useState<boolean>(false);
  const [hideOperator, setHideOperator] = useState<boolean>(false);
  const [timeLeft, setTimeLeft] = useState<number>(60);
  const [selectedTimerDuration, setSelectedTimerDuration] = useState<number>(60);
  const [customTimerDuration, setCustomTimerDuration] = useState<number>(45);
  const [questionLimit, setQuestionLimit] = useState<number>(20);
  const [questionsAnswered, setQuestionsAnswered] = useState<number>(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const [lifetimeQuestions, setLifetimeQuestions] = useState<number>(getInitialLifetimeQuestions());
  const [showSummary, setShowSummary] = useState<boolean>(false);
  const [animationClass, setAnimationClass] = useState<string>('');
  const [streakMessage, setStreakMessage] = useState<string>('');
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [numpadLayout, setNumpadLayout] = useState<'phone' | 'calculator'>(getInitialNumpadLayout());
  const [bgColor, setBgColor] = useState<string>(() => {
    try {
      return window.localStorage.getItem('mathFlashcardsBgColor') || '';
    } catch (e) {
      console.error(e);
      return '';
    }
  });


  const [allowNegatives, setAllowNegatives] = useState<boolean>(getInitialAllowNegatives());

  const [enableScreenShake, setEnableScreenShake] = useState<boolean>(getInitialEnableShake());
  const [hideTimer, setHideTimer] = useState<boolean>(getInitialHideTimer());

  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsHideTimer', hideTimer.toString());
    } catch (e) {
      console.error(e);
    }
  }, [hideTimer]);


  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsEnableShake', enableScreenShake.toString());
    } catch (e) {
      console.error(e);
    }
  }, [enableScreenShake]);


  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsAllowNegatives', allowNegatives.toString());
    } catch (e) {
      console.error(e);
    }
  }, [allowNegatives]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [runScores, setRunScores] = useState<RunScore[]>(getInitialRunScores());

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isSpeedRunActive && gameMode === 'timeAttack' && startTime) {
      setTimeout(() => setElapsedTime((Date.now() - startTime) / 1000), 0);
    }
  }, [timeLeft, isSpeedRunActive, gameMode, startTime]);

  const updateBgColor = (color: string) => {
    setBgColor(color);
    try {
      window.localStorage.setItem('mathFlashcardsBgColor', color);
    } catch (err) {
      console.error("Local storage error:", err);
    }
  };

  const handleExportCSV = () => {
    if (history.length === 0) return;
    const header = "Num1,Operation,Num2,UserAnswer,CorrectAnswer,IsCorrect\n";
    const rows = history.map(h => `${h.num1},${h.operation},${h.num2},${h.userAnswer},${h.correctAnswer},${h.isCorrect}`).join("\n");
    const csvContent = "data:text/csv;charset=utf-8," + header + rows;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "math_flashcards_history.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Initialize first problem safely
  useEffect(() => {
    setTimeout(() => {
      const { n1, n2, selectedOp } = generateRandomProblem(difficulty, allowedOperations, allowNegatives);
      setNum1(n1);
      setNum2(n2);
      setOperation(selectedOp);
      setUserAnswer('');
      setMessage('');
    }, 0);
  }, [difficulty, allowedOperations, allowNegatives]);


  const scoreRef = useRef(score);
  useEffect(() => {
    scoreRef.current = score;
  }, [score]);

  useEffect(() => {
    let timerId: ReturnType<typeof setInterval>;
    if (isSpeedRunActive && (gameMode === 'time' || gameMode === 'timeAttack') && timeLeft > 0) {
      timerId = setInterval(() => {
        setTimeLeft(t => t - 1);
      }, 1000);
    } else if (isSpeedRunActive && (gameMode === 'time' || gameMode === 'timeAttack') && timeLeft === 0) {
      setTimeout(() => {
        setIsSpeedRunActive(false);
        setShowSummary(true);
        const newScoreObj = { score: scoreRef.current, date: Date.now() };
        setRunScores(prev => {
          const updated = [...prev, newScoreObj].slice(-10);
          try {
            window.localStorage.setItem('mathFlashcardsRunScores', JSON.stringify(updated));
          } catch(err) {
             console.error("Local storage error:", err);
          }
          return updated;
        });
      }, 0);

    }
    return () => clearInterval(timerId);
  }, [isSpeedRunActive, gameMode, timeLeft]);

  const generateProblem = useCallback(() => {
    const { n1, n2, selectedOp } = generateRandomProblem(difficulty, allowedOperations, allowNegatives);
    setNum1(n1);
    setNum2(n2);
    setOperation(selectedOp);
    setUserAnswer('');
    if (isHardcoreMode) {
      setHideOperator(true);
      setTimeout(() => {
        setHideOperator(false);
      }, 1500);
    } else {
      setHideOperator(false);
    }
    if (!isSpeedRunActive || ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft > 0 : (gameMode === 'questions' ? questionsAnswered < questionLimit : true))) {
      setMessage('');
    }
    inputRef.current?.focus();
  }, [difficulty, isSpeedRunActive, timeLeft, allowedOperations, gameMode, questionsAnswered, questionLimit, isHardcoreMode, allowNegatives]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in the input
      if (e.target instanceof HTMLInputElement) return;

      if (e.key === 'n' || e.key === 'N') {
        if (!isSpeedRunActive || ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft > 0 : (gameMode === 'questions' ? questionsAnswered < questionLimit : true))) {
          generateProblem();
        }
      } else if (e.key === 'd' || e.key === 'D') {
        setDifficulty(prev => prev === 'easy' ? 'medium' : prev === 'medium' ? 'hard' : 'easy');
      } else if (e.key === 'o' || e.key === 'O') {
        setAllowedOperations(prev => {
           const map: Operation[][] = [['+'], ['+', '-'], ['+', '-', '*'], ['+', '-', '*', '/']];
           const currentIndex = map.findIndex(arr => arr.length === prev.length);
           return map[(currentIndex + 1) % map.length];
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSpeedRunActive, timeLeft, generateProblem, gameMode, questionsAnswered, questionLimit]);


  const updateStreak = (newStreak: number) => {
    setStreak(newStreak);
    if (newStreak > bestHistoricalCombo) {
      setBestHistoricalCombo(newStreak);
    }
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

  const resetHighScore = () => {
    setHighScore(0);
    try {
      window.localStorage.removeItem('mathFlashcardsHighScore');
    } catch (e) {
      console.error("Local storage error:", e);
    }
  };

  const resetStreak = () => {
    setStreak(0);
    try {
      window.localStorage.removeItem('mathFlashcardsStreak');
    } catch (e) {
      console.error("Local storage error:", e);
    }
  };



  const updateNumpadLayout = (layout: 'phone' | 'calculator') => {
    setNumpadLayout(layout);
    try {
      window.localStorage.setItem('mathFlashcardsNumpadLayout', layout);
    } catch (e) {
      console.error("Local storage error:", e);
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
    if (gameMode === 'time' || gameMode === 'timeAttack') {
      setTimeLeft(selectedTimerDuration === 0 ? customTimerDuration : selectedTimerDuration);
      setStartTime(Date.now());
    } else {
      setStartTime(Date.now());
    }
    setQuestionsAnswered(0);
    setHistory([]);
    setIsSpeedRunActive(true);
    setShowSummary(false);
    setMessage('');
    generateProblem();
  };

  const checkAnswer = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSpeedRunActive && (gameMode === 'time' || gameMode === 'timeAttack') && timeLeft === 0) return;
    if (isSpeedRunActive && gameMode === 'questions' && questionsAnswered >= questionLimit) return;
    if (isSuddenDeathMode && showSummary) return;

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

    const newLifetime = lifetimeQuestions + 1;
    setLifetimeQuestions(newLifetime);
    try {
      window.localStorage.setItem('mathFlashcardsLifetimeQuestions', newLifetime.toString());
    } catch (e) {
      console.error("Local storage error:", e);
    }

    if (isCorrect) {
      setMessage("Correct!");
      if (soundEnabled) playSound('correct');
      setAnswerStatus('correct');
      setTimeout(() => setAnswerStatus(null), 500);
      setAnimationClass('flash-correct');
      setTimeout(() => setAnimationClass(''), 500);

      let points = 1;
      if (streak >= 10 && maxComboMultiplier >= 3) points = 3;
      else if (streak >= 5 && maxComboMultiplier >= 2) points = 2;

      const newScore = score + points;
      setScore(newScore);
      setScoreBump(true);
      setTimeout(() => setScoreBump(false), 400);

      const newStreak = streak + 1;
      updateStreak(newStreak);

      if (isSpeedRunActive && gameMode === 'timeAttack') {
        setTimeLeft(t => t + 2); // Add 2 seconds for a correct answer in Time Attack
      }

      if (newStreak > 0 && newStreak % 10 === 0) {
        const pieces = [...Array(30)].map(() => ({
          left: `${Math.random() * 100}%`,
          delay: `${Math.random() * 0.5}s`,
          color: ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#9b59b6'][Math.floor(Math.random() * 5)]
        }));
        setConfettiPieces(pieces);
        setShowConfetti(true);
        setTimeout(() => setShowConfetti(false), 2000);
      }

      if (newStreak > 0 && newStreak % 5 === 0) {
        const msg = STREAK_MESSAGES[Math.floor(Math.random() * STREAK_MESSAGES.length)];
        setStreakMessage(msg);
        setTimeout(() => setStreakMessage(''), 2000);
      }

      updateHighScore(newScore);
      const newQuestionsAnswered = questionsAnswered + 1;
      setQuestionsAnswered(newQuestionsAnswered);

      if (isSpeedRunActive && gameMode === 'questions' && newQuestionsAnswered >= questionLimit) {
        setElapsedTime((Date.now() - (startTime || Date.now())) / 1000);
        setIsSpeedRunActive(false);
        setShowSummary(true);
      } else {
        if (gameMode === 'endless' && newQuestionsAnswered % 10 === 0) {
           if (difficulty === 'easy') setDifficulty('medium');
           else if (difficulty === 'medium') setDifficulty('hard');
        }
        setTimeout(() => {
          generateProblem();
        }, 500); // Shorter timeout for faster gameplay
      }

    } else {
      if (isSuddenDeathMode) {
        setMessage(`Incorrect! Sudden Death over.`);
        if (soundEnabled) playSound('incorrect');
      setAnswerStatus('incorrect');
      setTimeout(() => setAnswerStatus(null), 500);
      setAnimationClass(enableScreenShake ? 'flash-incorrect shake-animation' : 'flash-incorrect');
        setTimeout(() => setAnimationClass(''), 500);
        updateStreak(0);
        setShowSummary(true);
        const newScoreObj = { score: scoreRef.current, date: Date.now() };
        setRunScores(prev => {
          const updated = [...prev, newScoreObj].slice(-10);
          try {
            window.localStorage.setItem('mathFlashcardsRunScores', JSON.stringify(updated));
          } catch(err) {
             console.error("Local storage error:", err);
          }
          return updated;
        });
        setIsSpeedRunActive(false);
      } else {
        setMessage(`Incorrect. Try again!`);
        setAnswerStatus('incorrect');
        setTimeout(() => setAnswerStatus(null), 500);
        setAnimationClass(enableScreenShake ? 'flash-incorrect shake-animation' : 'flash-incorrect');
        setTimeout(() => setAnimationClass(''), 500);
        updateStreak(0); // Reset streak
        setUserAnswer('');
        inputRef.current?.focus();
      }
    }
  };



  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT' || document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'e') {
        setDifficulty('easy');
      } else if (key === 'm') {
        setDifficulty('medium');
      } else if (key === 'h') {
        setDifficulty('hard');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);


  const handleFactoryReset = () => {
    if (!window.confirm("Are you sure you want to delete all local storage data? This cannot be undone.")) return;

    const keys = [
      'mathFlashcardsHighScore',
      'mathFlashcardsTheme',
      'mathFlashcardsStreak',
      'mathFlashcardsNumpadLayout',
      'mathFlashcardsRunScores',
      'mathFlashcardsLifetimeQuestions',
      'mathFlashcardsBgColor',
      'mathFlashcardsAllowNegatives',
      'mathFlashcardsEnableShake',
      'mathFlashcardsHideTimer'
    ];

    keys.forEach(k => {
      try { window.localStorage.removeItem(k); } catch (e) { console.error(e); }
    });

    setHighScore(0);
    setTheme('light');
    setStreak(0);
    setNumpadLayout('phone');
    setRunScores([]);
    setLifetimeQuestions(0);
    setBgColor('');
    setAllowNegatives(false);
    setEnableScreenShake(true);
    setHideTimer(false);
  };

  const clearRunHistory = () => {
    if (!window.confirm("Are you sure you want to clear your run history?")) return;
    setRunScores([]);
    try {
      window.localStorage.removeItem('mathFlashcardsRunScores');
    } catch (e) {
      console.error("Local storage error:", e);
    }
  };

  return (
    <div className={`app-wrapper ${theme} font-size-${accessibilityFontSize}`} style={{ backgroundColor: theme === 'light' && bgColor ? bgColor : undefined }}>
    <div className={`app-container ${theme}`}>
      <div className="header-top">
        <h1>Math Flashcards</h1>
        <div>
          <button onClick={toggleTheme} className="theme-toggle" style={{ marginRight: '0.5rem' }}>
            {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
          </button>
          <button onClick={() => setSoundEnabled(!soundEnabled)} className="theme-toggle">
            {soundEnabled ? '🔊 Sound On' : '🔇 Sound Off'}
          </button>

          <button onClick={() => setZenMode(!zenMode)} className="theme-toggle">
            {zenMode ? '🌿 Zen On' : '🌿 Zen Off'}
          </button>

        </div>
      </div>



      <div className="color-picker" style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
        <span style={{ alignSelf: 'center', fontSize: '0.9rem' }}>Background:</span>
        <button className="color-btn" style={{ backgroundColor: '#f0f4f8' }} onClick={() => updateBgColor('#f0f4f8')} title="Default"></button>
        <button className="color-btn" style={{ backgroundColor: '#e8f5e9' }} onClick={() => updateBgColor('#e8f5e9')} title="Light Green"></button>
        <button className="color-btn" style={{ backgroundColor: '#fff3e0' }} onClick={() => updateBgColor('#fff3e0')} title="Light Orange"></button>
        <button className="color-btn" style={{ backgroundColor: '#e3f2fd' }} onClick={() => updateBgColor('#e3f2fd')} title="Light Blue"></button>
      </div>


      {!zenMode && (
      <div className="header-stats-container">

        <div className="header-stats">
          <div className="stat">Score: <span className={scoreBump ? "score-bump" : ""}>{score}</span></div>
          <div className="stat" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div>
              Streak: {streak} 🔥
              {streak >= 10 ? ' (x3)' : (streak >= 5 ? ' (x2)' : '')}
              <button onClick={resetStreak} className="reset-btn" title="Reset Streak" disabled={isSpeedRunActive}>↺</button>
            </div>
            <progress value={streak % 5} max={5} style={{ width: '80px', marginTop: '4px' }} title="Next Milestone"></progress>
          </div>
          <div className="stat">
            High Score: {highScore}
            <button onClick={resetHighScore} className="reset-btn" title="Reset High Score" disabled={isSpeedRunActive}>↺</button>
          </div>
          <div className="stat">Total Questions: {lifetimeQuestions}</div>
        </div>
      </div>
      )}

      <div className="controls">
        <div className="difficulty-selector">
          <label htmlFor="maxComboMultiplier">Max Combo:</label>
          <select
            id="maxComboMultiplier"
            value={maxComboMultiplier}
            onChange={(e) => setMaxComboMultiplier(parseInt(e.target.value, 10))}
          >
            <option value={1}>x1</option>
            <option value={2}>x2</option>
            <option value={3}>x3</option>
          </select>
        </div>

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

        <div className="difficulty-selector">
          <label htmlFor="accessibilityFontSize">Font Size:</label>
          <select
            id="accessibilityFontSize"
            value={accessibilityFontSize}
            onChange={(e) => setAccessibilityFontSize(e.target.value as 'normal' | 'large' | 'extra-large')}
          >
            <option value="normal">Normal</option>
            <option value="large">Large</option>
            <option value="extra-large">Extra Large</option>
          </select>
        </div>

        <div className="difficulty-selector">
          <label htmlFor="flashcardSize">Card Size:</label>
          <select
            id="flashcardSize"
            value={flashcardSize}
            onChange={(e) => setFlashcardSize(e.target.value as 'small' | 'medium' | 'large')}
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </div>

        <div className="difficulty-selector">
          <label htmlFor="numpadLayout">Numpad:</label>
          <select
            id="numpadLayout"
            value={numpadLayout}
            onChange={(e) => updateNumpadLayout(e.target.value as 'phone' | 'calculator')}
          >
            <option value="phone">Phone (123 top)</option>
            <option value="calculator">Calc (789 top)</option>
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
          <label style={{display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: '0.5rem'}}>
            <input type="checkbox" checked={allowNegatives} onChange={(e) => setAllowNegatives(e.target.checked)} disabled={isSpeedRunActive} />
            Allow Negatives
          </label>
          <label style={{display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: '0.5rem'}}>
            <input type="checkbox" checked={enableScreenShake} onChange={(e) => setEnableScreenShake(e.target.checked)} />
            Screen Shake
          </label>
          <label style={{display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: '0.5rem'}}>
            <input type="checkbox" checked={hideTimer} onChange={(e) => setHideTimer(e.target.checked)} />
            Hide Timer
          </label>
          <button onClick={handleFactoryReset} className="reset-btn" style={{marginTop: '0.5rem', padding: '0.5rem', background: '#e74c3c', color: 'white', borderRadius: '4px', cursor: 'pointer', border: 'none', width: '100%'}}>
            Factory Reset
          </button>
        </div>

        <div className="speed-run-controls">

          {isSpeedRunActive ? (
            !zenMode && ((gameMode === 'time' || gameMode === 'timeAttack') ? (
              <div className="progress-container" style={{ visibility: hideTimer ? 'hidden' : 'visible' }}>
                <div className="progress-bar" style={{ width: `${(timeLeft / selectedTimerDuration) * 100}%` }}></div>
                <div className="progress-text">{timeLeft}s</div>
              </div>
            ) : (
              <div className="progress-container" style={{ visibility: hideTimer ? 'hidden' : 'visible' }}>
                <div className="progress-bar" style={{ width: `${(questionsAnswered / questionLimit) * 100}%` }}></div>
                <div className="progress-text">{questionsAnswered} / {questionLimit}</div>
              </div>
            ))
          ) : (

            <div className="timer-select-container" style={{display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end'}}>
              <label style={{display: 'flex', alignItems: 'center', gap: '0.2rem', cursor: 'pointer', fontSize: '0.9rem'}}>
                <input
                  type="checkbox"
                  checked={isSuddenDeathMode}
                  onChange={(e) => setIsSuddenDeathMode(e.target.checked)}
                />
                Sudden Death
              </label>
              <label style={{display: 'flex', alignItems: 'center', gap: '0.2rem', cursor: 'pointer', fontSize: '0.9rem'}}>
                <input
                  type="checkbox"
                  checked={isHardcoreMode}
                  onChange={(e) => setIsHardcoreMode(e.target.checked)}
                />
                Hardcore
              </label>
              <select value={gameMode} onChange={(e) => setGameMode(e.target.value as 'time' | 'questions' | 'endless')} className="timer-select">
                <option value="time">Time Limit</option>
                <option value="questions">Question Limit</option>
                <option value="endless">Endless</option>
                <option value="timeAttack">Time Attack</option>
              </select>
              {(gameMode === 'time' || gameMode === 'timeAttack') ? (
                <>
                  <select value={selectedTimerDuration} onChange={(e) => setSelectedTimerDuration(parseInt(e.target.value, 10))} className="timer-select">
                    <option value={30}>30s</option>
                    <option value={60}>60s</option>
                    <option value={120}>120s</option>
                    <option value={0}>Custom</option>
                  </select>
                  {selectedTimerDuration === 0 && (
                    <input
                      type="number"
                      value={customTimerDuration}
                      onChange={(e) => setCustomTimerDuration(parseInt(e.target.value, 10) || 0)}
                      className="timer-select"
                      style={{width: '60px', padding: '0.4rem'}}
                      min="1"
                    />
                  )}
                </>
              ) : gameMode === 'questions' ? (
                <select value={questionLimit} onChange={(e) => setQuestionLimit(parseInt(e.target.value, 10))} className="timer-select">
                  <option value={10}>10 Qs</option>
                  <option value={20}>20 Qs</option>
                  <option value={50}>50 Qs</option>
                </select>
              ) : null}
              <button type="button" onClick={startSpeedRun} className="speed-run-button">Start Challenge</button>
            </div>
          )}
        </div>
      </div>


      {showConfetti && (
        <div className="confetti-container">
          {confettiPieces.map((piece, i) => (
            <div key={i} className="confetti-piece" style={{ left: piece.left, animationDelay: piece.delay, backgroundColor: piece.color }}></div>
          ))}
        </div>
      )}

      <div className={`flashcard flashcard-${flashcardSize} ${animationClass}`}>

        <div className="problem" style={{position: 'relative'}}>
          {answerStatus && (
            <div className={`answer-feedback ${answerStatus}`}>
              {answerStatus === 'correct' ? '✓' : '✗'}
            </div>
          )}
          {streak >= 5 && (
            <span style={{position: 'absolute', top: '-10px', right: '-10px', background: '#f1c40f', color: '#000', padding: '0.2rem 0.5rem', borderRadius: '10px', fontSize: '1rem', fontWeight: 'bold', animation: 'pulse 0.5s'}}>
              {streak >= 10 ? 'x3' : 'x2'}
            </span>
          )}

          <span className="number">{num1}</span>
          <span className="operation" style={{minWidth: '2rem', textAlign: 'center'}}>{hideOperator ? '?' : operation}</span>
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
            disabled={isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= questionLimit : false))}
          />
          <button type="submit" className="submit-button" disabled={isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= questionLimit : false))}>Check</button>
        </form>

        <div className="numpad">
          {(numpadLayout === 'phone' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [7, 8, 9, 4, 5, 6, 1, 2, 3]).map(num => (
            <button
              key={num}
              type="button"
              className="numpad-btn"
              disabled={isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= questionLimit : false))}
              onClick={() => setUserAnswer(prev => prev + num)}
            >
              {num}
            </button>
          ))}
          <button
            type="button"
            className="numpad-btn control-btn"
            disabled={isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= questionLimit : false))}
            onClick={() => setUserAnswer('')}
          >
            C
          </button>
          <button
            type="button"
            className="numpad-btn"
            disabled={isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= questionLimit : false))}
            onClick={() => setUserAnswer(prev => prev + '0')}
          >
            0
          </button>
          <button
            type="button"
            className="numpad-btn control-btn"
            disabled={isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= questionLimit : false))}
            onClick={() => setUserAnswer(prev => prev.slice(0, -1))}
          >
            ⌫
          </button>
        </div>
      </div>

      {message && <div className={`message ${message === 'Correct!' ? 'success' : (message.includes('Time') ? 'info' : 'error')}`}>{message}</div>}
      {streakMessage && <div className="message" style={{color: '#9b59b6', animation: 'pulse 1s infinite'}}>{streakMessage}</div>}

      <button type="button" onClick={generateProblem} className="next-button" disabled={isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= questionLimit : false))}>Skip / Next Problem</button>

      {showSummary && (
        <div className="summary-modal-overlay">
          <div className="summary-modal">
            <h2>{isSuddenDeathMode && !isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft > 0 : questionsAnswered < questionLimit) ? "Game Over!" : ((gameMode === 'time' || gameMode === 'timeAttack') ? "Time's Up!" : "Challenge Complete!")}</h2>
            <p>Final Score: <strong>{score}</strong></p>
            <p>High Score: <strong>{highScore}</strong></p>
            <p>Best Combo: <strong>{bestHistoricalCombo}</strong></p>
            <p>Questions Answered: <strong>{questionsAnswered}</strong></p>
            <p>Accuracy: <strong>{history.length > 0 ? ((history.filter(h => h.isCorrect).length / history.length) * 100).toFixed(1) : 0}%</strong></p>
            <div style={{fontSize: '0.9rem', marginBottom: '1rem', color: '#7f8c8d'}}>
              {['+', '-', '*', '/'].map(op => {
                const opHistory = history.filter(h => h.operation === op);
                if (opHistory.length === 0) return null;
                const correctCount = opHistory.filter(h => h.isCorrect).length;
                return (
                  <span key={op} style={{marginRight: '1rem'}}>
                    {op}: {((correctCount / opHistory.length) * 100).toFixed(0)}%
                  </span>
                );
              })}
            </div>
            <p>Average Time: <strong>{questionsAnswered > 0 ? ((gameMode === 'time' ? (selectedTimerDuration === 0 ? customTimerDuration : selectedTimerDuration) : (gameMode === 'timeAttack' ? elapsedTime : elapsedTime)) / questionsAnswered).toFixed(2) : 0}s</strong></p>


            {runScores.length > 0 && (
              <div className="scores-graph-container" style={{marginTop: '1.5rem', marginBottom: '1.5rem'}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem'}}>
                  <h3 style={{margin: 0, fontSize: '1.1rem'}}>Last 10 Runs</h3>
                  <button onClick={clearRunHistory} className="submit-button" style={{padding: '0.2rem 0.5rem', fontSize: '0.8rem', backgroundColor: '#e74c3c'}}>Clear History</button>
                </div>
                <div style={{display: 'flex', alignItems: 'flex-end', height: '100px', gap: '4px', borderBottom: '1px solid #bdc3c7', paddingBottom: '4px'}}>
                  {runScores.map((run, i) => {
                    const maxScore = Math.max(...runScores.map(r => r.score), 10);
                    const heightPercent = (run.score / maxScore) * 100;
                    return (
                      <div key={i} style={{flex: 1, backgroundColor: '#3498db', height: `${heightPercent}%`, position: 'relative', minHeight: '10px'}} title={`Score: ${run.score}`}>
                        <span style={{position: 'absolute', bottom: '-20px', left: '50%', transform: 'translateX(-50%)', fontSize: '0.7rem', color: '#7f8c8d'}}>{run.score}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="history-container">
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem'}}>
                <h3 style={{margin: 0}}>History</h3>
                {history.length > 0 && (
                  <button onClick={handleExportCSV} className="submit-button" style={{padding: '0.2rem 0.5rem', fontSize: '0.8rem'}}>Export CSV</button>
                )}
              </div>
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
