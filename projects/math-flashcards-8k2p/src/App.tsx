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
    if (!allowNegativesParam && difficulty !== 'hard' && n2 > n1) {
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





function getInitialHideSkipButton(): boolean {
  try {
    return window.localStorage.getItem('mathFlashcardsHideSkipButton') === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
    return false;
  }
}



function getInitialHideHighScore(): boolean {
  try {
    return window.localStorage.getItem('mathFlashcardsHideHighScore') === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
    return false;
  }
}


function getInitialFlashcardTextColor(): string {
  try {
    return window.localStorage.getItem('mathFlashcardsTextColor') || '';
  } catch (e) {
    console.error("Local storage error:", e);
    return '';
  }
}

function getInitialDisableConfetti(): boolean {
  try {
    return window.localStorage.getItem('mathFlashcardsDisableConfetti') === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
    return false;
  }
}

function getInitialLowBatteryMode(): boolean {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsLowBatteryMode');
    if (stored !== null) return stored === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return false;
}

function getInitialMirrorMode(): boolean {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsMirrorMode');
    if (stored !== null) return stored === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return false;
}

function getInitialHideStreak(): boolean {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsHideStreak');
    if (stored !== null) return stored === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return false;
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




function getInitialCustomTimer(): number {
  try {
    const item = window.localStorage.getItem('mathFlashcardsCustomTimer');
    return item ? parseInt(item, 10) : 45;
  } catch (e) {
    console.error(e);
    return 45;
  }
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


function getInitialAutoDarkMode(): boolean {
  try {
    const item = window.localStorage.getItem('mathFlashcardsAutoDarkMode');
    return item ? item === 'true' : false;
  } catch (e) {
    console.error(e);
    return false;
  }
}



function getInitialFontFamily(): string {
  try {
    return window.localStorage.getItem('mathFlashcardsFontFamily') || 'sans-serif';
  } catch (e) {
    console.error("Local storage error:", e);
    return 'sans-serif';
  }
}

function getInitialStrictMode(): boolean {
  try {
    return window.localStorage.getItem('mathFlashcardsStrictMode') === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
    return false;
  }
}

function getInitialCorrectColor(): string {
  try {
    return window.localStorage.getItem('mathFlashcardsCorrectColor') || '#2ecc71';
  } catch (e) {
    console.error("Local storage error:", e);
    return '#2ecc71';
  }
}

function getInitialIncorrectColor(): string {
  try {
    return window.localStorage.getItem('mathFlashcardsIncorrectColor') || '#e74c3c';
  } catch (e) {
    console.error("Local storage error:", e);
    return '#e74c3c';
  }
}

function getInitialDailyGoal(): number {
  try {
    const item = window.localStorage.getItem('mathFlashcardsDailyGoal');
    return item ? parseInt(item, 10) : 50;
  } catch (e) {
    console.error(e);
    return 50;
  }
}

function getInitialDailyQuestions(): { date: string, count: number } {
  const today = new Date().toISOString().split('T')[0];
  try {
    const item = window.localStorage.getItem('mathFlashcardsDailyQuestions');
    if (item) {
      const parsed = JSON.parse(item);
      if (parsed.date === today) {
        return parsed;
      }
    }
  } catch (e) {
    console.error(e);
  }
  return { date: today, count: 0 };
}

function getInitialHideStats(): boolean {
  try {
    return window.localStorage.getItem('mathFlashcardsHideStats') === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
    return false;
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



function getInitialHapticEnabled(): boolean {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsHapticEnabled');
    if (stored !== null) return stored === 'true';
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return false;
}

function getInitialFullHistory(): HistoryItem[] {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsFullHistory');
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return [];
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


function getInitialLifetimeCorrect(): number {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsLifetimeCorrect');
    if (stored) return parseInt(stored, 10);
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return 0;
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

function getInitialAvgTimePerDigit(): number {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsAvgTimePerDigit');
    if (stored) return parseFloat(stored);
  } catch (e) {
    console.error("Local storage error:", e);
  }
  return 0;
}

function getInitialTotalDigitsAnswered(): number {
  try {
    const stored = window.localStorage.getItem('mathFlashcardsTotalDigitsAnswered');
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
  const [autoDarkMode, setAutoDarkMode] = useState<boolean>(getInitialAutoDarkMode());

  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsAutoDarkMode', autoDarkMode.toString());
    } catch (e) {
      console.error(e);
    }
  }, [autoDarkMode]);

  useEffect(() => {
    if (!autoDarkMode) return;
    const checkTheme = () => {
      const hour = new Date().getHours();
      const shouldBeDark = hour >= 18 || hour <= 6;
      setTheme(shouldBeDark ? 'dark' : 'light');
    };
    checkTheme(); // run once immediately
    const interval = setInterval(checkTheme, 60000);
    return () => clearInterval(interval);
  }, [autoDarkMode]);

  const [zenMode, setZenMode] = useState<boolean>(getInitialZenMode());

  const [fontFamily, setFontFamily] = useState<string>(getInitialFontFamily());
  const [strictMode, setStrictMode] = useState<boolean>(getInitialStrictMode());
  const [correctColor, setCorrectColor] = useState<string>(getInitialCorrectColor());
  const [incorrectColor, setIncorrectColor] = useState<string>(getInitialIncorrectColor());
  const [dailyGoal, setDailyGoal] = useState<number>(getInitialDailyGoal());
  const [dailyQuestions, setDailyQuestions] = useState<{ date: string, count: number }>(getInitialDailyQuestions());
  const [hideStats, setHideStats] = useState<boolean>(getInitialHideStats());
  const [hideStreak, setHideStreak] = useState<boolean>(getInitialHideStreak());
  const [mirrorMode, setMirrorMode] = useState<boolean>(getInitialMirrorMode());
  const [lowBatteryMode, setLowBatteryMode] = useState<boolean>(getInitialLowBatteryMode());
  const [hideSkipButton, setHideSkipButton] = useState<boolean>(getInitialHideSkipButton());
  const [disableConfetti, setDisableConfetti] = useState<boolean>(getInitialDisableConfetti());
  const [hideHighScore, setHideHighScore] = useState<boolean>(getInitialHideHighScore());
  const [flashcardTextColor, setFlashcardTextColor] = useState<string>(getInitialFlashcardTextColor());



  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsLowBatteryMode', lowBatteryMode.toString()); } catch (e) { console.error(e); } }, [lowBatteryMode]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsHideSkipButton', hideSkipButton.toString()); } catch (e) { console.error(e); } }, [hideSkipButton]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsDisableConfetti', disableConfetti.toString()); } catch (e) { console.error(e); } }, [disableConfetti]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsHideHighScore', hideHighScore.toString()); } catch (e) { console.error(e); } }, [hideHighScore]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsTextColor', flashcardTextColor); } catch (e) { console.error(e); } }, [flashcardTextColor]);

  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsMirrorMode', mirrorMode.toString()); } catch (e) { console.error(e); } }, [mirrorMode]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsHideStreak', hideStreak.toString()); } catch (e) { console.error(e); } }, [hideStreak]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsFontFamily', fontFamily); } catch (e) { console.error(e); } }, [fontFamily]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsStrictMode', strictMode.toString()); } catch (e) { console.error(e); } }, [strictMode]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsCorrectColor', correctColor); } catch (e) { console.error(e); } }, [correctColor]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsIncorrectColor', incorrectColor); } catch (e) { console.error(e); } }, [incorrectColor]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsDailyGoal', dailyGoal.toString()); } catch (e) { console.error(e); } }, [dailyGoal]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsDailyQuestions', JSON.stringify(dailyQuestions)); } catch (e) { console.error(e); } }, [dailyQuestions]);
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsHideStats', hideStats.toString()); } catch (e) { console.error(e); } }, [hideStats]);



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
  const [todayStreak, setTodayStreak] = useState<number>(0);
  const [nightOwlUnlocked, setNightOwlUnlocked] = useState<boolean>(() => { try { return window.localStorage.getItem('mathFlashcardsNightOwl') === 'true'; } catch { return false; } });
  const [bgImage, setBgImage] = useState<string>(() => { try { return window.localStorage.getItem('mathFlashcardsBgImage') || ''; } catch { return ''; } });
  const [highScore, setHighScore] = useState<number>(getInitialHighScore());
  const [showHighScoreBanner, setShowHighScoreBanner] = useState<boolean>(false);
  const [bestHistoricalCombo, setBestHistoricalCombo] = useState<number>(getInitialBestCombo());

  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsBestCombo', bestHistoricalCombo.toString());
    } catch (e) {
      console.error(e);
    }
  }, [bestHistoricalCombo]);


  const [isSpeedRunActive, setIsSpeedRunActive] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
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
  const [customTimerDuration, setCustomTimerDuration] = useState<number>(getInitialCustomTimer());

  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsCustomTimer', customTimerDuration.toString());
    } catch (e) {
      console.error(e);
    }
  }, [customTimerDuration]);

  const [questionLimit, setQuestionLimit] = useState<number>(20);
  const [customQuestionLimit, setCustomQuestionLimit] = useState<number>(20);
  const [questionsAnswered, setQuestionsAnswered] = useState<number>(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const [lifetimeQuestions, setLifetimeQuestions] = useState<number>(getInitialLifetimeQuestions());
  const [lifetimeCorrectAnswers, setLifetimeCorrectAnswers] = useState<number>(getInitialLifetimeCorrect());
  const [showSummary, setShowSummary] = useState<boolean>(false);
  const [animationClass, setAnimationClass] = useState<string>('');
  const [streakMessage, setStreakMessage] = useState<string>('');
  const [avgTimePerDigit, setAvgTimePerDigit] = useState<number>(getInitialAvgTimePerDigit());
  const [totalDigitsAnswered, setTotalDigitsAnswered] = useState<number>(getInitialTotalDigitsAnswered());
  const [questionStartTime, setQuestionStartTime] = useState<number>(0);

  useEffect(() => {
    try { window.localStorage.setItem('mathFlashcardsAvgTimePerDigit', avgTimePerDigit.toString()); } catch (e) { console.error(e); }
  }, [avgTimePerDigit]);

  useEffect(() => {
    try { window.localStorage.setItem('mathFlashcardsTotalDigitsAnswered', totalDigitsAnswered.toString()); } catch (e) { console.error(e); }
  }, [totalDigitsAnswered]);
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

  const [graphPaper, setGraphPaper] = useState<boolean>(() => { try { return window.localStorage.getItem('mathFlashcardsGraphPaper') === 'true'; } catch { return false; } });
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsGraphPaper', graphPaper.toString()); } catch (e) { console.error(e); } }, [graphPaper]);

  const [correctIcon, setCorrectIcon] = useState<string>(() => { try { return window.localStorage.getItem('mathFlashcardsCorrectIcon') || '✓'; } catch { return '✓'; } });
  useEffect(() => { try { window.localStorage.setItem('mathFlashcardsCorrectIcon', correctIcon); } catch (e) { console.error(e); } }, [correctIcon]);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [, setFullHistory] = useState<HistoryItem[]>(getInitialFullHistory());
  const [hapticEnabled, setHapticEnabled] = useState(getInitialHapticEnabled());

  useEffect(() => {
    try {
      window.localStorage.setItem('mathFlashcardsHapticEnabled', hapticEnabled.toString());
    } catch (e) {
      console.error(e);
    }
  }, [hapticEnabled]);
  const [runScores, setRunScores] = useState<RunScore[]>(getInitialRunScores());

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isSpeedRunActive && gameMode === 'timeAttack' && startTime) {
      setTimeout(() => setElapsedTime((Date.now() - startTime) / 1000), 0);
    }
  }, [timeLeft, isSpeedRunActive, gameMode, startTime]);

  const handleBgImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const url = event.target?.result as string;
        setBgImage(url);
        try { window.localStorage.setItem('mathFlashcardsBgImage', url); } catch(e) { console.error(e); }
      };
      reader.readAsDataURL(file);
    }
  };

  const updateBgColor = (color: string) => {
    setBgColor(color);
    try {
      window.localStorage.setItem('mathFlashcardsBgColor', color);
    } catch (err) {
      console.error("Local storage error:", err);
    }
  };


  const resetSettings = () => {
    if (window.confirm("Are you sure you want to reset all settings to their default values? (Scores and history will not be affected.)")) {
      const keysToRemove = [
        'mathFlashcardsLowBatteryMode', 'mathFlashcardsMirrorMode', 'mathFlashcardsHideStreak',
        'mathFlashcardsHideTimer', 'mathFlashcardsEnableShake', 'mathFlashcardsAllowNegatives',
        'mathFlashcardsCustomTimer', 'mathFlashcardsZenMode', 'mathFlashcardsMaxCombo',
        'mathFlashcardsFontSize', 'mathFlashcardsAutoDarkMode', 'mathFlashcardsFontFamily',
        'mathFlashcardsStrictMode', 'mathFlashcardsCorrectColor', 'mathFlashcardsIncorrectColor',
        'mathFlashcardsDailyGoal', 'mathFlashcardsHideStats', 'mathFlashcardsTheme',
        'mathFlashcardsNumpadLayout', 'mathFlashcardsHapticEnabled', 'mathFlashcardsHideSkipButton'
      ];
      keysToRemove.forEach(k => window.localStorage.removeItem(k));

      setLowBatteryMode(false);
      setMirrorMode(false);
      setHideStreak(false);
      setHideTimer(false);
      setEnableScreenShake(true);
      setAllowNegatives(false);
      setCustomTimerDuration(45);
      setZenMode(false);
      setMaxComboMultiplier(3);
      setAccessibilityFontSize('normal');
      setAutoDarkMode(false);
      setFontFamily('sans-serif');
      setStrictMode(false);
      setCorrectColor('#2ecc71');
      setIncorrectColor('#e74c3c');
      setDailyGoal(50);
      setHideStats(false);
      setTheme('light');
      setNumpadLayout('phone');
      setHapticEnabled(false);
      setHideSkipButton(false);
      setDisableConfetti(false);
      setHideHighScore(false);
      setFlashcardTextColor('');
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
      setQuestionStartTime(Date.now());
    }, 0);
  }, [difficulty, allowedOperations, allowNegatives]);


  const scoreRef = useRef(score);
  useEffect(() => {
    scoreRef.current = score;
  }, [score]);

  useEffect(() => {
    let timerId: ReturnType<typeof setInterval>;
    if (isSpeedRunActive && !isPaused && (gameMode === 'time' || gameMode === 'timeAttack') && timeLeft > 0) {
      timerId = setInterval(() => {
        setTimeLeft(t => t - 1);
      }, 1000);
    } else if (isSpeedRunActive && !isPaused && (gameMode === 'time' || gameMode === 'timeAttack') && timeLeft === 0) {
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
  }, [isSpeedRunActive, gameMode, timeLeft, isPaused]);

  const handleGiveUp = () => {
    const correctAns = operation === '+' ? num1 + num2 : operation === '-' ? num1 - num2 : operation === '*' ? num1 * num2 : Math.floor(num1 / num2);
    const newHistoryItem: HistoryItem = { num1, num2, operation, userAnswer: 'Skipped', correctAnswer: correctAns, isCorrect: false };
    setHistory(prev => [newHistoryItem, ...prev].slice(0, 100));
    setStreak(0);
    setTodayStreak(0);
    if (soundEnabled) playSound('incorrect');
    setMessage(`Skipped! Answer was ${correctAns}`);
    setAnswerStatus('incorrect');
    setTimeout(() => { generateProblem(); setAnswerStatus(null); }, 1000);
  };

  const generateProblem = useCallback(() => {
    const { n1, n2, selectedOp } = generateRandomProblem(difficulty, allowedOperations, allowNegatives);
    setNum1(n1);
    setNum2(n2);
    setOperation(selectedOp);
    setUserAnswer('');
    setQuestionStartTime(Date.now());
    if (isHardcoreMode) {
      setHideOperator(true);
      setTimeout(() => {
        setHideOperator(false);
      }, 1500);
    } else {
      setHideOperator(false);
    }
    if (!isSpeedRunActive || ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft > 0 : (gameMode === 'questions' ? questionsAnswered < (questionLimit === 0 ? customQuestionLimit : questionLimit) : true))) {
      setMessage('');
    }
    inputRef.current?.focus();
  }, [difficulty, isSpeedRunActive, timeLeft, allowedOperations, gameMode, questionsAnswered, questionLimit, customQuestionLimit, isHardcoreMode, allowNegatives]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in the input
      if (e.target instanceof HTMLInputElement) return;

      if (e.key === 'n' || e.key === 'N') {
        if (!isSpeedRunActive || ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft > 0 : (gameMode === 'questions' ? questionsAnswered < (questionLimit === 0 ? customQuestionLimit : questionLimit) : true))) {
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
  }, [isSpeedRunActive, timeLeft, generateProblem, gameMode, questionsAnswered, questionLimit, customQuestionLimit]);


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
      if (highScore > 0 && !showHighScoreBanner) {
        setShowHighScoreBanner(true);
        setTimeout(() => setShowHighScoreBanner(false), 3000);
      }
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
    const hour = new Date().getHours();
    if (hour >= 0 && hour < 4 && !nightOwlUnlocked) {
      setNightOwlUnlocked(true);
      try { window.localStorage.setItem('mathFlashcardsNightOwl', 'true'); } catch(e) { console.error(e); }
    }
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
    if (isSpeedRunActive && gameMode === 'questions' && questionsAnswered >= (questionLimit === 0 ? customQuestionLimit : questionLimit)) return;
    if (isSuddenDeathMode && showSummary) return;

    const answer = parseInt(userAnswer, 10);
    if (isNaN(answer)) {
      setMessage("Please enter a valid number.");
      return;
    }

    const responseTime = Date.now() - questionStartTime;
    const digitCount = userAnswer.replace(/[^0-9]/g, '').length;
    if (digitCount > 0) {
      const timePerDigit = responseTime / 1000 / digitCount;
      const newTotalDigits = totalDigitsAnswered + digitCount;
      const newAvgTime = ((avgTimePerDigit * totalDigitsAnswered) + (timePerDigit * digitCount)) / newTotalDigits;
      setTotalDigitsAnswered(newTotalDigits);
      setAvgTimePerDigit(newAvgTime);
    }

    let correctAnswer = 0;
    switch (operation) {
      case '+': correctAnswer = num1 + num2; break;
      case '-': correctAnswer = num1 - num2; break;
      case '*': correctAnswer = num1 * num2; break;
      case '/': correctAnswer = num1 / num2; break;
    }


        const isCorrect = strictMode ? userAnswer === correctAnswer.toString() : answer === correctAnswer;
    setHistory(prev => [...prev, {
      num1, num2, operation, userAnswer, correctAnswer, isCorrect
    }]);

    setFullHistory(prev => {
      const next = [...prev, { num1, num2, operation, userAnswer, correctAnswer, isCorrect }];
      try {
        window.localStorage.setItem('mathFlashcardsFullHistory', JSON.stringify(next));
      } catch (e) {
        console.error("Local storage error:", e);
      }
      return next;
    });

    const newLifetime = lifetimeQuestions + 1;
    setLifetimeQuestions(newLifetime);
    setDailyQuestions(prev => ({ date: prev.date, count: prev.count + 1 }));

    const newCorrect = lifetimeCorrectAnswers + (isCorrect ? 1 : 0);
    setLifetimeCorrectAnswers(newCorrect);

    try {
      window.localStorage.setItem('mathFlashcardsLifetimeQuestions', newLifetime.toString());
      window.localStorage.setItem('mathFlashcardsLifetimeCorrect', newCorrect.toString());
    } catch (e) {
      console.error("Local storage error:", e);
    }

    if (isCorrect) {
      setMessage("Correct!");
      if (soundEnabled) playSound('correct');
      if (hapticEnabled && typeof window !== 'undefined' && window.navigator && window.navigator.vibrate) window.navigator.vibrate(50);
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

      const newStreak = streak + 1; setTodayStreak(ts => ts + 1);
      updateStreak(newStreak);

      if (isSpeedRunActive && gameMode === 'timeAttack') {
        setTimeLeft(t => t + 2); // Add 2 seconds for a correct answer in Time Attack
      }

      if (newStreak > 0 && newStreak % 100 === 0) {
        const pieces = [...Array(100)].map(() => ({
          left: `${Math.random() * 100}%`,
          delay: `${Math.random() * 2}s`,
          color: Math.random() > 0.5 ? '#f1c40f' : '#f39c12'
        }));
        if (!disableConfetti) {
          setConfettiPieces(pieces);
          setShowConfetti(true);
          setTimeout(() => setShowConfetti(false), 4000);
        }
        setStreakMessage("100 STREAK! GODLIKE!");
      } else if (newStreak > 0 && newStreak % 10 === 0) {
        const pieces = [...Array(30)].map(() => ({
          left: `${Math.random() * 100}%`,
          delay: `${Math.random() * 0.5}s`,
          color: ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#9b59b6'][Math.floor(Math.random() * 5)]
        }));
        if (!disableConfetti) {
          setConfettiPieces(pieces);
          setShowConfetti(true);
          setTimeout(() => setShowConfetti(false), 2000);
        }
      }

      if (newStreak > 0 && newStreak % 5 === 0) {
        const msg = STREAK_MESSAGES[Math.floor(Math.random() * STREAK_MESSAGES.length)];
        setStreakMessage(msg);
        setTimeout(() => setStreakMessage(''), 2000);
      }

      updateHighScore(newScore);
      const newQuestionsAnswered = questionsAnswered + 1;
      setQuestionsAnswered(newQuestionsAnswered);

      if (isSpeedRunActive && gameMode === 'questions' && newQuestionsAnswered >= (questionLimit === 0 ? customQuestionLimit : questionLimit)) {
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
      } else if (key === 'p') {
        setIsPaused(prev => isSpeedRunActive ? !prev : false);
      } else if (key === 's') {
        const btn = document.querySelector('.next-button') as HTMLButtonElement;
        if (btn && !btn.disabled) {
          btn.click();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSpeedRunActive]);


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
    <div className={`app-wrapper ${theme} font-size-${accessibilityFontSize} ${streak >= 5 && !lowBatteryMode ? 'streak-active-bg' : ''} ${graphPaper ? 'graph-paper-bg' : ''}`} style={{ backgroundColor: theme === 'light' && bgColor ? bgColor : undefined, backgroundImage: bgImage && !graphPaper ? `url(${bgImage})` : (graphPaper ? undefined : 'none'), backgroundSize: 'cover', backgroundPosition: 'center' }}>
    <div className={`app-container ${theme}`} style={{ fontFamily }}>
      <div className="header-top">
        <h1>Math Flashcards {nightOwlUnlocked && <span title="Night Owl">🦉</span>}{isHardcoreMode && <span className="badge hardcore">Hardcore</span>}</h1>
        <div>
          <button onClick={toggleTheme} className="theme-toggle" style={{ marginRight: '0.5rem' }} disabled={autoDarkMode}>
            {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
          </button>
          <button onClick={() => setAutoDarkMode(!autoDarkMode)} className="theme-toggle" style={{ marginRight: '0.5rem' }}>
            {autoDarkMode ? '🌙 Auto Dark' : '⚪ Manual Dark'}
          </button>
          <button onClick={() => setSoundEnabled(!soundEnabled)} className="theme-toggle">
            {soundEnabled ? '🔊 Sound On' : '🔇 Sound Off'}
          </button>

          <button onClick={() => setZenMode(!zenMode)} className="theme-toggle">
            {zenMode ? '🌿 Zen On' : '🌿 Zen Off'}
          </button>

        </div>
      </div>



      <button onClick={resetSettings} className="submit-button" style={{marginTop: '1rem', backgroundColor: '#e74c3c'}}>Reset Settings to Default</button>
      <div className="color-picker" style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <label style={{fontSize: '0.8rem', marginRight: '1rem'}}>BG Image: <input type="file" accept="image/*" onChange={handleBgImageUpload} style={{width: '120px'}}/></label>
        <div className="setting-group">
          <label htmlFor="flashcardTextColor">Flashcard Text Color (Leave blank for default)</label>
          <input id="flashcardTextColor" type="text" placeholder="#333333 or black" value={flashcardTextColor} onChange={(e) => setFlashcardTextColor(e.target.value)} />
        </div>
        <label style={{fontSize: '0.8rem', marginRight: '1rem'}}>Correct: <input type="color" value={correctColor} onChange={(e) => setCorrectColor(e.target.value)} /></label>
        <label style={{fontSize: '0.8rem', marginRight: '1rem'}}>Incorrect: <input type="color" value={incorrectColor} onChange={(e) => setIncorrectColor(e.target.value)} /></label>
      </div>

      <div className="difficulty-selector" style={{ marginBottom: '1rem', display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="dailyGoal">Daily Goal: <input id="dailyGoal" type="number" min="1" value={dailyGoal} onChange={(e) => setDailyGoal(parseInt(e.target.value, 10) || 50)} style={{ width: '60px' }} /></label>
        <label htmlFor="fontFamily">Font: <select id="fontFamily" value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}><option value="sans-serif">Sans-serif</option><option value="serif">Serif</option><option value="monospace">Monospace</option></select></label>
        <label htmlFor="strictMode"><input id="strictMode" type="checkbox" checked={strictMode} onChange={(e) => setStrictMode(e.target.checked)} disabled={isSpeedRunActive} /> Strict Mode</label>
                <label htmlFor="disableConfetti"><input id="disableConfetti" type="checkbox" checked={disableConfetti} onChange={(e) => setDisableConfetti(e.target.checked)} /> Disable Confetti</label>
        <label htmlFor="hideSkipButton"><input id="hideSkipButton" type="checkbox" checked={hideSkipButton} onChange={(e) => setHideSkipButton(e.target.checked)} /> Hide 'Give Up / Skip' Button</label>
        <label htmlFor="hideStats"><input id="hideStats" type="checkbox" checked={hideStats} onChange={(e) => setHideStats(e.target.checked)} /> Hide Stats</label>
        <label htmlFor="hideHighScore"><input id="hideHighScore" type="checkbox" checked={hideHighScore} onChange={(e) => setHideHighScore(e.target.checked)} /> Hide High Score</label>
        <label htmlFor="hideStreak"><input id="hideStreak" type="checkbox" checked={hideStreak} onChange={(e) => setHideStreak(e.target.checked)} /> Hide Streak</label>
        <label htmlFor="mirrorMode"><input id="mirrorMode" type="checkbox" checked={mirrorMode} onChange={(e) => setMirrorMode(e.target.checked)} /> Mirror Mode</label>
        <label htmlFor="lowBatteryMode"><input id="lowBatteryMode" type="checkbox" checked={lowBatteryMode} onChange={(e) => setLowBatteryMode(e.target.checked)} /> Low Battery Mode</label>
      </div>

      <div className="color-picker" style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>

        <span style={{ alignSelf: 'center', fontSize: '0.9rem' }}>Background:</span>
        <button className="color-btn" style={{ backgroundColor: '#f0f4f8' }} onClick={() => updateBgColor('#f0f4f8')} title="Default"></button>
        <button className="color-btn" style={{ backgroundColor: '#e8f5e9' }} onClick={() => updateBgColor('#e8f5e9')} title="Light Green"></button>
        <button className="color-btn" style={{ backgroundColor: '#fff3e0' }} onClick={() => updateBgColor('#fff3e0')} title="Light Orange"></button>
        <button className="color-btn" style={{ backgroundColor: '#e3f2fd' }} onClick={() => updateBgColor('#e3f2fd')} title="Light Blue"></button>
      </div>


      {!zenMode && (
      <div className="header-stats-container" style={{ display: hideStats ? 'none' : 'flex' }}>

        {!hideStats && <div className="daily-goal-container" style={{ width: '100%', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#7f8c8d' }}>
            <span>Daily Goal</span>
            <span>{dailyQuestions.count} / {dailyGoal}</span>
          </div>
          <div style={{ width: '100%', height: '8px', backgroundColor: '#ecf0f1', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min((dailyQuestions.count / dailyGoal) * 100, 100)}%`, height: '100%', backgroundColor: '#3498db', transition: 'width 0.3s' }}></div>
          </div>
        </div>}
        <div className="header-stats">
          <div className="stat">Score: <span className={scoreBump ? "score-bump" : ""}>{score}</span></div>
          {!hideStreak && (
          <div className="stat" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div>
              Streak: {streak} 🔥 | Today: {todayStreak}
              {streak >= 10 ? ' (x3)' : (streak >= 5 ? ' (x2)' : '')}
              <button onClick={resetStreak} className="reset-btn" title="Reset Streak" disabled={isSpeedRunActive}>↺</button>
            </div>
            <progress value={streak % 5} max={5} style={{ width: '80px', marginTop: '4px' }} title="Next Milestone"></progress>
          </div>
          )}
          {!hideHighScore && (<div className="stat">
            High Score: {highScore}
            <button onClick={resetHighScore} className="reset-btn" title="Reset High Score" disabled={isSpeedRunActive}>↺</button>
          </div>)}
          <div className="stat">Total Questions: {lifetimeQuestions} | Total Correct: {lifetimeCorrectAnswers} | Acc: {lifetimeQuestions > 0 ? (lifetimeCorrectAnswers / lifetimeQuestions * 100).toFixed(1) : 0}%</div>
          <div className="stat">Avg Time / Digit: {avgTimePerDigit > 0 ? avgTimePerDigit.toFixed(2) + 's' : 'N/A'} | Avg Time / Question: {(avgTimePerDigit > 0 && lifetimeQuestions > 0) ? (avgTimePerDigit * (totalDigitsAnswered / lifetimeQuestions)).toFixed(2) + 's' : 'N/A'}</div>
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

          <label style={{display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: '0.5rem'}}>
            <input type="checkbox" checked={hapticEnabled} onChange={(e) => setHapticEnabled(e.target.checked)} />
            Haptic Feedback
          </label>
          <label style={{display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: '0.5rem'}}>
            <input type="checkbox" checked={graphPaper} onChange={(e) => setGraphPaper(e.target.checked)} />
            Graph Paper
          </label>

          <div style={{display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem'}}>
            <label htmlFor="correctIconSelect">Correct Icon:</label>
            <select
              id="correctIconSelect"
              value={correctIcon}
              onChange={(e) => setCorrectIcon(e.target.value)}
              style={{padding: '0.2rem', borderRadius: '4px', border: '1px solid #bdc3c7'}}
            >
              <option value="✓">✓</option>
              <option value="⭐">⭐</option>
              <option value="👍">👍</option>
              <option value="🎉">🎉</option>
              <option value="🌟">🌟</option>
            </select>
          </div>

          <button onClick={handleFactoryReset} className="reset-btn" style={{marginTop: '0.5rem', padding: '0.5rem', background: '#e74c3c', color: 'white', borderRadius: '4px', cursor: 'pointer', border: 'none', width: '100%'}}>
            Factory Reset
          </button>
        </div>

        <div className="speed-run-controls">

          {isSpeedRunActive ? (
            !zenMode && (
              (gameMode === 'time' || gameMode === 'timeAttack') ? (
                <div className="progress-container" style={{ visibility: hideTimer ? 'hidden' : 'visible' }}>
                  <div className="progress-bar" style={{ width: `${(timeLeft / selectedTimerDuration) * 100}%` }}></div>
                  <div className="progress-text">{timeLeft}s</div>
                </div>
              ) : gameMode === 'questions' ? (
                <div className="progress-container" style={{ visibility: hideTimer ? 'hidden' : 'visible' }}>
                  <div className="progress-bar" style={{ width: `${(questionsAnswered / (questionLimit === 0 ? customQuestionLimit : questionLimit)) * 100}%` }}></div>
                  <div className="progress-text">{questionsAnswered} / {questionLimit === 0 ? customQuestionLimit : questionLimit}</div>
                </div>
              ) : gameMode === 'endless' ? (
                <div className="progress-container" style={{ visibility: hideTimer ? 'hidden' : 'visible' }}>
                  <div className="progress-bar" style={{ width: `${((questionsAnswered % 10) / 10) * 100}%` }}></div>
                  <div className="progress-text">{10 - (questionsAnswered % 10)} to next level</div>
                </div>
              ) : null
            )
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
                <>
                  <select value={questionLimit} onChange={(e) => setQuestionLimit(parseInt(e.target.value, 10))} className="timer-select">
                    <option value={10}>10 Qs</option>
                    <option value={20}>20 Qs</option>
                    <option value={50}>50 Qs</option>
                    <option value={0}>Custom</option>
                  </select>
                  {questionLimit === 0 && (
                      <input
                        type="number"
                        value={customQuestionLimit}
                        onChange={(e) => setCustomQuestionLimit(parseInt(e.target.value, 10) || 1)}
                        className="timer-select"
                        style={{width: '60px', padding: '0.4rem'}}
                        min="1"
                      />
                  )}
                </>
              ) : null}
              <button type="button" onClick={startSpeedRun} className="speed-run-button">Start Challenge</button>
            </div>
          )}
        </div>
      </div>


      {showConfetti && !lowBatteryMode && (
        <div className="confetti-container">
          {confettiPieces.map((piece, i) => (
            <div key={i} className="confetti-piece" style={{ left: piece.left, animationDelay: piece.delay, backgroundColor: piece.color }}></div>
          ))}
        </div>
      )}

      <div className={`flashcard flashcard-${flashcardSize} ${animationClass} ${mirrorMode ? 'mirror-mode' : ''}`} style={{color: flashcardTextColor || undefined}}>

        <div className="problem" style={{position: 'relative'}}>
          {answerStatus && (
            <div className={`answer-feedback ${answerStatus}`} style={{ color: answerStatus === 'correct' ? correctColor : incorrectColor }}>
              {answerStatus === 'correct' ? correctIcon : '✗'}
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
            disabled={isPaused || (isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= (questionLimit === 0 ? customQuestionLimit : questionLimit) : false)))}
          />
          <button type="submit" className="submit-button" disabled={isPaused || (isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= (questionLimit === 0 ? customQuestionLimit : questionLimit) : false)))}>Check</button>
        </form>

        <div className="numpad">
          {(numpadLayout === 'phone' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [7, 8, 9, 4, 5, 6, 1, 2, 3]).map(num => (
            <button
              key={num}
              type="button"
              className="numpad-btn"
              disabled={isPaused || (isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= (questionLimit === 0 ? customQuestionLimit : questionLimit) : false)))}
              onClick={() => setUserAnswer(prev => prev + num)}
            >
              {num}
            </button>
          ))}
          <button
            type="button"
            className="numpad-btn control-btn"
            disabled={isPaused || (isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= (questionLimit === 0 ? customQuestionLimit : questionLimit) : false)))}
            onClick={() => setUserAnswer('')}
          >
            C
          </button>
          <button
            type="button"
            className="numpad-btn"
            disabled={isPaused || (isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= (questionLimit === 0 ? customQuestionLimit : questionLimit) : false)))}
            onClick={() => setUserAnswer(prev => prev + '0')}
          >
            0
          </button>
          <button
            type="button"
            className="numpad-btn control-btn"
            disabled={isPaused || (isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= (questionLimit === 0 ? customQuestionLimit : questionLimit) : false)))}
            onClick={() => setUserAnswer(prev => prev.slice(0, -1))}
          >
            ⌫
          </button>
        </div>
      </div>

      {history.length > 0 && !isSpeedRunActive && !showSummary && (
        <div className="mini-history" style={{marginTop: '1rem', width: '100%', maxWidth: '250px'}}>
          <h4 style={{margin: '0 0 0.5rem 0', textAlign: 'center'}}>Recent</h4>
          <ul className="history-list" style={{fontSize: '0.9rem', textAlign: 'center'}}>
            {history.slice(-5).reverse().map((item, index) => (
               <li key={index} className={item.isCorrect ? 'history-correct' : 'history-incorrect'}>
                 {item.num1} {item.operation} {item.num2} = {item.userAnswer}
                 {!item.isCorrect && <span> ({item.correctAnswer})</span>}
               </li>
            ))}
          </ul>
        </div>
      )}

      {showHighScoreBanner && <div className="message" style={{color: '#f39c12', animation: 'pulse 0.5s infinite'}}>New High Score! 🏆</div>}
      {message && <div className={`message ${message === 'Correct!' ? 'success' : (message.includes('Time') ? 'info' : 'error')}`}>{message}</div>}
      {streakMessage && <div className="message" style={{color: '#9b59b6', animation: 'pulse 1s infinite'}}>{streakMessage}</div>}
      {isPaused && <div className="message info" style={{animation: 'pulse 1.5s infinite'}}>Paused (Press 'P' to resume)</div>}

      {!hideSkipButton && <button type="button" onClick={handleGiveUp} className="next-button" disabled={isPaused || (isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft === 0 : (gameMode === 'questions' ? questionsAnswered >= (questionLimit === 0 ? customQuestionLimit : questionLimit) : false)))}>Give Up / Skip</button>}
      {isSpeedRunActive && <button type="button" onClick={() => setIsPaused(!isPaused)} className="next-button" style={{marginLeft: '0.5rem'}}>{isPaused ? 'Resume (P)' : 'Pause (P)'}</button>}

      {showSummary && (
        <div className="summary-modal-overlay">
          <div className="summary-modal">
            <h2>{isSuddenDeathMode && !isSpeedRunActive && ((gameMode === 'time' || gameMode === 'timeAttack') ? timeLeft > 0 : questionsAnswered < (questionLimit === 0 ? customQuestionLimit : questionLimit)) ? "Game Over!" : ((gameMode === 'time' || gameMode === 'timeAttack') ? "Time's Up!" : "Challenge Complete!")}</h2>
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

            {history.length > 0 && (() => {
              const counts = { '+': 0, '-': 0, '*': 0, '/': 0 };
              history.forEach(h => counts[h.operation as keyof typeof counts]++);
              const total = history.length;
              let currentDeg = 0;
              const segments = Object.entries(counts).filter(([, count]) => count > 0).map(([op, count]) => {
                const percentage = (count / total) * 360;
                const colors = { '+': '#3498db', '-': '#e74c3c', '*': '#f1c40f', '/': '#2ecc71' };
                const segment = `${colors[op as keyof typeof colors]} ${currentDeg}deg ${currentDeg + percentage}deg`;
                currentDeg += percentage;
                return segment;
              });

              return (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2rem', marginTop: '1rem' }}>
                  <div style={{
                    width: '80px', height: '80px', borderRadius: '50%',
                    background: `conic-gradient(${segments.join(', ')})`
                  }}></div>
                  <div style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
                    {Object.entries(counts).filter(([, count]) => count > 0).map(([op, count]) => (
                      <span key={op} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ display: 'inline-block', width: '10px', height: '10px', backgroundColor: { '+': '#3498db', '-': '#e74c3c', '*': '#f1c40f', '/': '#2ecc71' }[op as keyof typeof counts] }}></span>
                        {op}: {((count / total) * 100).toFixed(0)}%
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}



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

            {history.filter(h => !h.isCorrect).length > 0 && (() => {
              const missed = history.filter(h => !h.isCorrect);
              const counts: Record<string, { count: number, item: HistoryItem }> = {};
              missed.forEach(h => {
                const key = `${h.num1} ${h.operation} ${h.num2}`;
                if (!counts[key]) counts[key] = { count: 0, item: h };
                counts[key].count++;
              });
              const hardest = Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 3);
              return (
                <div className="history-container" style={{ marginBottom: '1rem' }}>
                  <h3 style={{margin: '0 0 0.5rem 0'}}>Hardest Questions</h3>
                  <ul className="history-list">
                    {hardest.map(({ count, item }, index) => (
                      <li key={index} className="history-incorrect">
                        {item.num1} {item.operation} {item.num2} = ? <span>(Missed {count} times) (Correct: {item.correctAnswer})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

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
