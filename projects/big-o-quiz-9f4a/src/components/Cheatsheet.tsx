import React from 'react';
import { csData } from '../data';
import './Cheatsheet.css';

export const Cheatsheet: React.FC = () => {
  return (
    <div className="cheatsheet-container">
      <h2>Big-O Cheatsheet</h2>
      <table className="cheatsheet-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Best Time</th>
            <th>Average Time</th>
            <th>Worst Time</th>
            <th>Space Complexity</th>
          </tr>
        </thead>
        <tbody>
          {csData.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              <td>{item.type}</td>
              <td>{item.timeComplexity.best}</td>
              <td>{item.timeComplexity.average}</td>
              <td>{item.timeComplexity.worst}</td>
              <td>{item.spaceComplexity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
