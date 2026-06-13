import { useState, useEffect } from 'react';
import './App.css';

interface Upgrade {
  id: string;
  name: string;
  description: string;
  baseCost: number;
  incomeBoost: number;
}

const UPGRADES: Upgrade[] = [
  {
    id: 'lemonade',
    name: 'Lemonade Stand',
    description: 'A humble beginning. Earns $1/sec.',
    baseCost: 10,
    incomeBoost: 1,
  },
  {
    id: 'newspaper',
    name: 'Newspaper Delivery',
    description: 'Throw papers at doors. Earns $5/sec.',
    baseCost: 100,
    incomeBoost: 5,
  },
  {
    id: 'carwash',
    name: 'Car Wash',
    description: 'Make those cars shine. Earns $25/sec.',
    baseCost: 500,
    incomeBoost: 25,
  },
  {
    id: 'pizza',
    name: 'Pizza Delivery',
    description: 'Deliver hot pizzas. Earns $100/sec.',
    baseCost: 2000,
    incomeBoost: 100,
  },
  {
    id: 'startup',
    name: 'Tech Startup',
    description: 'Disrupt the industry. Earns $500/sec.',
    baseCost: 10000,
    incomeBoost: 500,
  },
];

function App() {
  const [money, setMoney] = useState(0);
  const [passiveIncome, setPassiveIncome] = useState(0);
  const [ownedUpgrades, setOwnedUpgrades] = useState<{ [id: string]: number }>({});
  const clickValue = 1;

  // Passive income effect
  useEffect(() => {
    if (passiveIncome === 0) return;

    const interval = setInterval(() => {
      setMoney((prevMoney) => prevMoney + passiveIncome);
    }, 1000);

    return () => clearInterval(interval);
  }, [passiveIncome]);

  const handleWork = () => {
    setMoney((prevMoney) => prevMoney + clickValue);
  };

  const buyUpgrade = (upgrade: Upgrade) => {
    const currentOwned = ownedUpgrades[upgrade.id] || 0;
    const cost = Math.floor(upgrade.baseCost * Math.pow(1.15, currentOwned));

    if (money >= cost) {
      setMoney((prevMoney) => prevMoney - cost);
      setPassiveIncome((prevIncome) => prevIncome + upgrade.incomeBoost);
      setOwnedUpgrades((prev) => ({
        ...prev,
        [upgrade.id]: currentOwned + 1,
      }));
    }
  };

  const getUpgradeCost = (upgrade: Upgrade) => {
    const currentOwned = ownedUpgrades[upgrade.id] || 0;
    return Math.floor(upgrade.baseCost * Math.pow(1.15, currentOwned));
  };

  const formatMoney = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(amount);
  };

  return (
    <div className="game-container">
      <header className="game-header">
        <h1>Billionaire Simulator</h1>
        <div className="stats">
          <div className="money-display">{formatMoney(money)}</div>
          <div className="income-display">{formatMoney(passiveIncome)} / sec</div>
        </div>
      </header>

      <main className="game-main">
        <section className="work-section">
          <button className="work-button" onClick={handleWork}>
            Work
            <span className="click-value">+{formatMoney(clickValue)}</span>
          </button>
        </section>

        <section className="upgrades-section">
          <h2>Investments</h2>
          <div className="upgrades-list">
            {UPGRADES.map((upgrade) => {
              const cost = getUpgradeCost(upgrade);
              const canAfford = money >= cost;
              const owned = ownedUpgrades[upgrade.id] || 0;

              return (
                <button
                  key={upgrade.id}
                  className={`upgrade-card ${!canAfford ? 'disabled' : ''}`}
                  onClick={() => buyUpgrade(upgrade)}
                  disabled={!canAfford}
                >
                  <div className="upgrade-info">
                    <h3>{upgrade.name}</h3>
                    <p>{upgrade.description}</p>
                    <span className="owned-count">Owned: {owned}</span>
                  </div>
                  <div className="upgrade-action">
                    <span className="cost">Cost: {formatMoney(cost)}</span>
                    <span className="boost">+{formatMoney(upgrade.incomeBoost)}/s</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
