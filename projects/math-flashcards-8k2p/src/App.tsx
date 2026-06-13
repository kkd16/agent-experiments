import { useState } from 'react';
import './App.css';

type Operation = '+' | '-' | '*';

function generateRandomProblem() {
  const ops: Operation[] = ['+', '-', '*'];
  const selectedOp = ops[Math.floor(Math.random() * ops.length)];
  let n1 = Math.floor(Math.random() * 12) + 1;
  let n2 = Math.floor(Math.random() * 12) + 1;

  if (selectedOp === '-' && n2 > n1) {
    [n1, n2] = [n2, n1];
  }

  return { n1, n2, selectedOp };
}

function App() {
  const [initialProblem] = useState(generateRandomProblem);
  const [operation, setOperation] = useState<Operation>(initialProblem.selectedOp);
  const [num1, setNum1] = useState<number>(initialProblem.n1);
  const [num2, setNum2] = useState<number>(initialProblem.n2);

  const [userAnswer, setUserAnswer] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [score, setScore] = useState<number>(0);

  const generateProblem = () => {
    const ops: Operation[] = ['+', '-', '*'];
    const selectedOp = ops[Math.floor(Math.random() * ops.length)];
    let n1 = Math.floor(Math.random() * 12) + 1;
    let n2 = Math.floor(Math.random() * 12) + 1;

    // Ensure n1 >= n2 for subtraction to avoid negative results initially
    if (selectedOp === '-' && n2 > n1) {
      [n1, n2] = [n2, n1];
    }

    setNum1(n1);
    setNum2(n2);
    setOperation(selectedOp);
    setUserAnswer('');
    setMessage('');
  };

  const checkAnswer = (e: React.FormEvent) => {
    e.preventDefault();
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
    }

    if (answer === correctAnswer) {
      setMessage("Correct!");
      setScore(s => s + 1);
      setTimeout(() => {
        generateProblem();
      }, 1000);
    } else {
      setMessage(`Incorrect. Try again!`);
    }
  };

  return (
    <div className="app-container">
      <h1>Math Flashcards</h1>
      <div className="score">Score: {score}</div>
      <div className="flashcard">
        <div className="problem">
          <span className="number">{num1}</span>
          <span className="operation">{operation}</span>
          <span className="number">{num2}</span>
        </div>
        <form onSubmit={checkAnswer} className="answer-form">
          <input
            type="number"
            value={userAnswer}
            onChange={(e) => setUserAnswer(e.target.value)}
            autoFocus
            className="answer-input"
            placeholder="?"
          />
          <button type="submit" className="submit-button">Check</button>
        </form>
      </div>
      {message && <div className={`message ${message === 'Correct!' ? 'success' : 'error'}`}>{message}</div>}
      <button onClick={generateProblem} className="next-button">Skip / Next Problem</button>
    </div>
  );
}

export default App;
