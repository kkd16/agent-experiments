import React, { useState } from 'react';
import { csData, type AlgorithmData } from '../data';
import './Quiz.css';

type QuestionType = 'averageTime' | 'worstTime' | 'space';

const getRandomQuestion = () => csData[Math.floor(Math.random() * csData.length)];
const getRandomType = (): QuestionType => {
  const types: QuestionType[] = ['averageTime', 'worstTime', 'space'];
  return types[Math.floor(Math.random() * types.length)];
};

export const Quiz: React.FC = () => {
  const [currentQuestion, setCurrentQuestion] = useState<AlgorithmData>(getRandomQuestion);
  const [showAnswer, setShowAnswer] = useState(false);
  const [questionType, setQuestionType] = useState<QuestionType>(getRandomType);
  const [score, setScore] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);

  const getNewQuestion = () => {
    setCurrentQuestion(getRandomQuestion());
    setQuestionType(getRandomType());
    setShowAnswer(false);
  };

  const handleReveal = () => {
    setShowAnswer(true);
    setTotalQuestions(prev => prev + 1);
  };

  const handleScore = (correct: boolean) => {
    if (correct) {
      setScore(prev => prev + 1);
    }
    getNewQuestion();
  };

  if (!currentQuestion) return null;

  let questionText = '';
  let answerText = '';

  switch (questionType) {
    case 'averageTime':
      questionText = `What is the AVERAGE Time Complexity of ${currentQuestion.name}?`;
      answerText = currentQuestion.timeComplexity.average;
      break;
    case 'worstTime':
      questionText = `What is the WORST Time Complexity of ${currentQuestion.name}?`;
      answerText = currentQuestion.timeComplexity.worst;
      break;
    case 'space':
      questionText = `What is the Space Complexity of ${currentQuestion.name}?`;
      answerText = currentQuestion.spaceComplexity;
      break;
  }

  return (
    <div className="quiz-container">
      <h2>Knowledge Check</h2>
      <div className="score-board">
        Score: {score} / {totalQuestions}
      </div>

      <div className={`flashcard ${showAnswer ? 'flipped' : ''}`}>
        <div className="flashcard-inner">
          <div className="flashcard-front">
            <h3>{questionText}</h3>
            <span className="hint-type">{currentQuestion.type}</span>
          </div>
          <div className="flashcard-back">
            <h3>{answerText}</h3>
          </div>
        </div>
      </div>

      <div className="quiz-controls">
        {!showAnswer ? (
          <button className="primary-btn" onClick={handleReveal}>Reveal Answer</button>
        ) : (
          <div className="feedback-controls">
            <p>Did you get it right?</p>
            <div className="btn-group">
              <button className="success-btn" onClick={() => handleScore(true)}>Yes</button>
              <button className="danger-btn" onClick={() => handleScore(false)}>No</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
