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
  {
    id: 'factory',
    name: 'Mega Factory',
    description: 'Mass production at its finest. Earns $2,500/sec.',
    baseCost: 75000,
    incomeBoost: 2500,
  },
  {
    id: 'conglomerate',
    name: 'Global Conglomerate',
    description: 'Own everything. Earns $15,000/sec.',
    baseCost: 500000,
    incomeBoost: 15000,
  },
  {
    id: 'moonbase',
    name: 'Moon Base',
    description: 'Lunar mining operations. Earns $100,000/sec.',
    baseCost: 4000000,
    incomeBoost: 100000,
  },
  {
    id: 'marscolony',
    name: 'Mars Colony',
    description: 'Multi-planetary species. Earns $750,000/sec.',
    baseCost: 35000000,
    incomeBoost: 750000,
  },
  {
    id: 'dysonsphere',
    name: 'Dyson Sphere',
    description: 'Harness the power of a star. Earns $5,000,000/sec.',
    baseCost: 300000000,
    incomeBoost: 5000000,
  },
];

function App() {
  const [money, setMoney] = useState<number>(0);
  const [lifetimeEarnings, setLifetimeEarnings] = useState<number>(0);
  const [prestigePoints, setPrestigePoints] = useState<number>(0);
  const [passiveIncome, setPassiveIncome] = useState<number>(0);
  const [ownedUpgrades, setOwnedUpgrades] = useState<{ [id: string]: number }>({});
  const clickValue = 1;
  const prestigeMultiplier = 1 + (prestigePoints * 0.1); // 10% bonus per point

  // Initialization state
  const [isLoaded, setIsLoaded] = useState(false);

  // Load game state
  useEffect(() => {
    const loadState = () => {
      if (isLoaded) return;

      try {
        const savedState = localStorage.getItem('billionaireSimulatorState');
        if (savedState) {
          const { savedMoney, savedUpgrades, lastSaveTime, savedPrestigePoints, savedLifetimeEarnings } = JSON.parse(savedState);

          // Ensure atomic update to avoid cascading renders
          let finalMoney = savedMoney || 0;
          let finalPassiveIncome = 0;

          if (savedUpgrades) {
            for (const upgrade of UPGRADES) {
              if (savedUpgrades[upgrade.id]) {
                finalPassiveIncome += upgrade.incomeBoost * savedUpgrades[upgrade.id];
              }
            }
          }

          let finalLifetimeEarnings = savedLifetimeEarnings || 0;

          if (lastSaveTime) {
            const now = Date.now();
            const timeDiffSeconds = Math.floor((now - lastSaveTime) / 1000);
            const offlineSeconds = Math.min(timeDiffSeconds, 24 * 60 * 60);

            if (offlineSeconds > 0 && finalPassiveIncome > 0) {
              const prestigeMultiplierInit = 1 + ((savedPrestigePoints || 0) * 0.1);
              const offlineEarnings = offlineSeconds * (finalPassiveIncome * prestigeMultiplierInit);
              finalMoney += offlineEarnings;
              finalLifetimeEarnings += offlineEarnings;
              console.log(`Earned ${offlineEarnings} while offline for ${offlineSeconds} seconds.`);
            }
          }

          setOwnedUpgrades(savedUpgrades || {});
          setPrestigePoints(savedPrestigePoints || 0);
          setLifetimeEarnings(finalLifetimeEarnings);
          setPassiveIncome(finalPassiveIncome);
          setMoney(finalMoney);
        }
      } catch (e) {
        console.warn("Could not load from localStorage", e);
      } finally {
        setIsLoaded(true);
      }
    };

    // Defer the state update to avoid calling setState synchronously within the effect
    const timeoutId = setTimeout(loadState, 0);
    return () => clearTimeout(timeoutId);
  }, [isLoaded]);

  // Auto-save game state
  useEffect(() => {
    if (!isLoaded) return;

    try {
      const state = {
        savedMoney: money,
        savedUpgrades: ownedUpgrades,
        savedPrestigePoints: prestigePoints,
        savedLifetimeEarnings: lifetimeEarnings,
        lastSaveTime: Date.now(),
      };
      localStorage.setItem('billionaireSimulatorState', JSON.stringify(state));
    } catch (e) {
      console.warn("Could not save to localStorage", e);
    }
  }, [money, ownedUpgrades, prestigePoints, lifetimeEarnings, isLoaded]);

  // Passive income effect
  useEffect(() => {
    if (passiveIncome === 0) return;

    const interval = setInterval(() => {
      setMoney((prevMoney) => prevMoney + (passiveIncome * prestigeMultiplier));
      setLifetimeEarnings((prevLifetime) => prevLifetime + (passiveIncome * prestigeMultiplier));
    }, 1000);

    return () => clearInterval(interval);
  }, [passiveIncome, prestigeMultiplier]);

  const handleWork = () => {
    setMoney((prevMoney) => prevMoney + (clickValue * prestigeMultiplier));
    setLifetimeEarnings((prevLifetime) => prevLifetime + (clickValue * prestigeMultiplier));
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

  // Prestige calculation
  // Base 1M earnings = 1 point, scaling quadratically
  const calculatePendingPrestigePoints = () => {
    const PRESTIGE_BASE = 1000000;
    if (lifetimeEarnings < PRESTIGE_BASE) return 0;
    return Math.floor(Math.sqrt(lifetimeEarnings / PRESTIGE_BASE));
  };

  const handlePrestige = () => {
    const newPoints = calculatePendingPrestigePoints();
    if (newPoints > 0) {
      if (window.confirm(`Are you sure you want to prestige? You will gain ${newPoints} prestige points and a +${newPoints * 10}% income bonus, but lose all your money and upgrades.`)) {
        setPrestigePoints(prev => prev + newPoints);
        setMoney(0);
        setPassiveIncome(0);
        setOwnedUpgrades({});
        setLifetimeEarnings(0); // Optional: reset lifetime so points are harder to earn, or keep it to accumulate. We'll reset it to make it a true run-based system.
      }
    }
  };

  const pendingPoints = calculatePendingPrestigePoints();

  return (
    <div className="game-container">
      <header className="game-header">
        <h1>Billionaire Simulator</h1>
        <div className="stats">
          <div className="money-display">{formatMoney(money)}</div>
          <div className="income-display">{formatMoney(passiveIncome * prestigeMultiplier)} / sec</div>
          {prestigePoints > 0 && (
            <div className="prestige-display">
              Prestige Bonus: +{prestigePoints * 10}%
            </div>
          )}
        </div>
      </header>

      <main className="game-main">
        <section className="work-section">
          <button className="work-button" onClick={handleWork}>
            Work
            <span className="click-value">+{formatMoney(clickValue * prestigeMultiplier)}</span>
          </button>
        </section>

        {(lifetimeEarnings > 500000 || prestigePoints > 0) && (
          <section className="prestige-section">
            <h2>Prestige</h2>
            <p className="prestige-desc">Reset progress to gain permanent bonuses.</p>
            <button
              className={`prestige-button ${pendingPoints === 0 ? 'disabled' : ''}`}
              onClick={handlePrestige}
              disabled={pendingPoints === 0}
            >
              Prestige Now
              <span className="prestige-gain">
                {pendingPoints > 0 ? `+${pendingPoints} Points` : `Reach ${formatMoney(1000000)} to prestige`}
              </span>
            </button>
          </section>
        )}

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
