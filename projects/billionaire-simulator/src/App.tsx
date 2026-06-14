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
  { id: 'lemonade', name: 'Lemonade Stand', description: 'A humble beginning. Earns $1/sec.', baseCost: 10, incomeBoost: 1 },
  { id: 'newspaper', name: 'Newspaper Delivery', description: 'Throw papers at doors. Earns $5/sec.', baseCost: 100, incomeBoost: 5 },
  { id: 'carwash', name: 'Car Wash', description: 'Make those cars shine. Earns $25/sec.', baseCost: 500, incomeBoost: 25 },
  { id: 'pizza', name: 'Pizza Delivery', description: 'Deliver hot pizzas. Earns $100/sec.', baseCost: 2000, incomeBoost: 100 },
  { id: 'startup', name: 'Tech Startup', description: 'Disrupt the industry. Earns $500/sec.', baseCost: 10000, incomeBoost: 500 },
  { id: 'factory', name: 'Mega Factory', description: 'Mass production at its finest. Earns $2,500/sec.', baseCost: 75000, incomeBoost: 2500 },
  { id: 'conglomerate', name: 'Global Conglomerate', description: 'Own everything. Earns $15,000/sec.', baseCost: 500000, incomeBoost: 15000 },
  { id: 'moonbase', name: 'Moon Base', description: 'Lunar mining operations. Earns $100,000/sec.', baseCost: 4000000, incomeBoost: 100000 },
  { id: 'marscolony', name: 'Mars Colony', description: 'Multi-planetary species. Earns $750,000/sec.', baseCost: 35000000, incomeBoost: 750000 },
  { id: 'dysonsphere', name: 'Dyson Sphere', description: 'Harness the power of a star. Earns $5,000,000/sec.', baseCost: 300000000, incomeBoost: 5000000 },
  { id: 'blackhole', name: 'Black Hole Harvester', description: 'Extract energy from a singularity. Earns $50M/sec.', baseCost: 2500000000, incomeBoost: 50000000 },
  { id: 'multiverse', name: 'Multiverse Gateway', description: 'Trade with alternate realities. Earns $1B/sec.', baseCost: 50000000000, incomeBoost: 1000000000 },
  { id: 'timemachine', name: 'Time Machine', description: 'Invest in the past, profit now. Earns $50B/sec.', baseCost: 1000000000000, incomeBoost: 50000000000 },
  { id: 'matrix', name: 'The Matrix', description: 'Simulate reality for ad revenue. Earns $1T/sec.', baseCost: 50000000000000, incomeBoost: 1000000000000 },
  { id: 'omnipotence', name: 'Omnipotence', description: 'You are everything. Earns $100T/sec.', baseCost: 1000000000000000, incomeBoost: 100000000000000 },
];

interface ClickUpgrade {
  id: string;
  name: string;
  description: string;
  baseCost: number;
  clickBoost: number;
}

const CLICK_UPGRADES: ClickUpgrade[] = [
  { id: 'coffee', name: 'Coffee', description: 'Work slightly harder. +$2/click.', baseCost: 50, clickBoost: 2 },
  { id: 'energydrink', name: 'Energy Drink', description: 'Heart palpitations. +$10/click.', baseCost: 500, clickBoost: 10 },
  { id: 'typingcourse', name: 'Typing Course', description: 'Type 120 WPM. +$50/click.', baseCost: 5000, clickBoost: 50 },
  { id: 'bionicfingers', name: 'Bionic Fingers', description: 'Cybernetic enhancements. +$500/click.', baseCost: 100000, clickBoost: 500 },
  { id: 'brainimplant', name: 'Brain Implant', description: 'Direct neural interface. +$10,000/click.', baseCost: 5000000, clickBoost: 10000 },
];

interface Achievement {
  id: string;
  name: string;
  description: string;
  condition: (money: number, lifetime: number, upgrades: Record<string, number>) => boolean;
}

const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_blood', name: 'First Blood', description: 'Earn your first $100', condition: (_, lifetime) => lifetime >= 100 },
  { id: 'thousand_aire', name: 'Thousand-aire', description: 'Earn $1,000', condition: (_, lifetime) => lifetime >= 1000 },
  { id: 'millionaire', name: 'Millionaire', description: 'Earn $1,000,000', condition: (_, lifetime) => lifetime >= 1000000 },
  { id: 'billionaire', name: 'Billionaire', description: 'Earn $1,000,000,000', condition: (_, lifetime) => lifetime >= 1000000000 },
  { id: 'trillionaire', name: 'Trillionaire', description: 'Earn $1,000,000,000,000', condition: (_, lifetime) => lifetime >= 1000000000000 },
  { id: 'business_owner', name: 'Business Owner', description: 'Own 10 Lemonade Stands', condition: (_money, _lifetime, upgrades) => (upgrades['lemonade'] || 0) >= 10 },
  { id: 'monopoly', name: 'Monopoly', description: 'Own 50 Global Conglomerates', condition: (_money, _lifetime, upgrades) => (upgrades['conglomerate'] || 0) >= 50 },
];

interface Manager {
  id: string;
  name: string;
  targetUpgrade: string;
  description: string;
  cost: number;
}

const MANAGERS: Manager[] = [
  { id: 'mgr_lemonade', name: 'Timmy', targetUpgrade: 'lemonade', description: 'Doubles Lemonade Stand income.', cost: 1000 },
  { id: 'mgr_newspaper', name: 'Paperboy Pete', targetUpgrade: 'newspaper', description: 'Doubles Newspaper Delivery income.', cost: 10000 },
  { id: 'mgr_carwash', name: 'Wash Master', targetUpgrade: 'carwash', description: 'Doubles Car Wash income.', cost: 50000 },
  { id: 'mgr_pizza', name: 'Chef Mario', targetUpgrade: 'pizza', description: 'Doubles Pizza Delivery income.', cost: 200000 },
  { id: 'mgr_startup', name: 'Tech Bro', targetUpgrade: 'startup', description: 'Doubles Tech Startup income.', cost: 1000000 },
];

function App() {
  const [money, setMoney] = useState<number>(0);
  const [lifetimeEarnings, setLifetimeEarnings] = useState<number>(0);
  const [prestigePoints, setPrestigePoints] = useState<number>(0);
  const [passiveIncome, setPassiveIncome] = useState<number>(0);
  const [ownedUpgrades, setOwnedUpgrades] = useState<{ [id: string]: number }>({});
  const [ownedClickUpgrades, setOwnedClickUpgrades] = useState<{ [id: string]: number }>({});
  const [unlockedAchievements, setUnlockedAchievements] = useState<string[]>([]);
  const [goldenInvestment, setGoldenInvestment] = useState<{ x: number, y: number, value: number } | null>(null);
  const [showStats, setShowStats] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [totalClicks, setTotalClicks] = useState<number>(0);
  const [timePlayed, setTimePlayed] = useState<number>(0);
  const [ownedManagers, setOwnedManagers] = useState<string[]>([]);
  const [offlineCapacityLevel, setOfflineCapacityLevel] = useState<number>(0);
  const [prestigePerks, setPrestigePerks] = useState<{ [id: string]: number }>({});
  const [toasts, setToasts] = useState<{ id: number, message: string }[]>([]);

  // Stock Market Minigame State
  const [stockPrice, setStockPrice] = useState<number>(100);
  const [ownedStocks, setOwnedStocks] = useState<number>(0);
  const [stockHistory, setStockHistory] = useState<number[]>(Array(10).fill(100));

  // Sound effects with Web Audio API
  const playSound = (type: "click" | "buy" | "prestige") => {
    try {
      const audioCtx = new (window.AudioContext || ((window as unknown) as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      if (type === "click") {
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(400, audioCtx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(600, audioCtx.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.1);
      } else if (type === "buy") {
        oscillator.type = "square";
        oscillator.frequency.setValueAtTime(800, audioCtx.currentTime);
        oscillator.frequency.setValueAtTime(1200, audioCtx.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.2);
      } else if (type === "prestige") {
        oscillator.type = "sawtooth";
        oscillator.frequency.setValueAtTime(200, audioCtx.currentTime);
        oscillator.frequency.linearRampToValueAtTime(800, audioCtx.currentTime + 0.5);
        gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.5);
      }
    } catch (e) {
      console.warn("Audio play failed", e);
    }
  };

  const addToast = (message: string) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  };

  const baseClickValue = 1 + Object.entries(ownedClickUpgrades).reduce((total, [id, count]) => {
    const upgrade = CLICK_UPGRADES.find(u => u.id === id);
    return total + (upgrade ? upgrade.clickBoost * count : 0);
  }, 0);
  const pClickBonus = (prestigePerks["clickBoost"] || 0) * 0.5; // +50% click value per level
  const clickValue = baseClickValue * (1 + pClickBonus);

  const pPassiveBonus = (prestigePerks["passiveBoost"] || 0) * 0.05; // +5% overall passive per level
  const prestigeMultiplier = 1 + (prestigePoints * 0.1) + pPassiveBonus; // 10% bonus per point + perk bonus

  // Initialization state
  const [isLoaded, setIsLoaded] = useState(false);

  // Load game state
  useEffect(() => {
    const loadState = () => {
      if (isLoaded) return;

      try {
        const savedState = localStorage.getItem("billionaireSimulatorState");
        if (savedState) {
          const { savedMoney, savedUpgrades, savedClickUpgrades, lastSaveTime, savedPrestigePoints, savedLifetimeEarnings, savedAchievements, savedTotalClicks, savedTimePlayed, savedManagers, savedStocks, savedOfflineCapacityLevel, savedPrestigePerks } = JSON.parse(savedState);

          let finalMoney = savedMoney || 0;
          let finalPassiveIncome = 0;
          const finalManagers = savedManagers || [];

          if (savedUpgrades) {
            for (const upgrade of UPGRADES) {
              if (savedUpgrades[upgrade.id]) {
                let boost = upgrade.incomeBoost * savedUpgrades[upgrade.id];
                if (finalManagers.some((mId: string) => {
                  const mgr = MANAGERS.find(mgr => mgr.id === mId);
                  return mgr && mgr.targetUpgrade === upgrade.id;
                })) {
                  boost *= 2;
                }
                finalPassiveIncome += boost;
              }
            }
          }

          let finalLifetimeEarnings = savedLifetimeEarnings || 0;
          const finalOfflineCapacityLevel = savedOfflineCapacityLevel || 0;
          const maxOfflineSeconds = (24 + (finalOfflineCapacityLevel * 24)) * 60 * 60; // Base 24h + 24h per level
          const pPerks = savedPrestigePerks || {};

          if (lastSaveTime) {
            const now = Date.now();
            const timeDiffSeconds = Math.floor((now - lastSaveTime) / 1000);
            const offlineSeconds = Math.min(timeDiffSeconds, maxOfflineSeconds);

            if (offlineSeconds > 0 && finalPassiveIncome > 0) {
              const pMultiplierBonus = (pPerks["passiveBoost"] || 0) * 0.05;
              const prestigeMultiplierInit = 1 + ((savedPrestigePoints || 0) * 0.1) + pMultiplierBonus;
              const offlineEarnings = offlineSeconds * (finalPassiveIncome * prestigeMultiplierInit);
              finalMoney += offlineEarnings;
              finalLifetimeEarnings += offlineEarnings;
              console.log(`Earned ${offlineEarnings} while offline for ${offlineSeconds} seconds.`);
            }
          }

          setOwnedUpgrades(savedUpgrades || {});
          setOwnedClickUpgrades(savedClickUpgrades || {});
          setOwnedManagers(finalManagers);
          setOfflineCapacityLevel(finalOfflineCapacityLevel);
          setPrestigePerks(pPerks);
          setUnlockedAchievements(savedAchievements || []);
          setPrestigePoints(savedPrestigePoints || 0);
          setLifetimeEarnings(finalLifetimeEarnings);
          setTotalClicks(savedTotalClicks || 0);
          setTimePlayed(savedTimePlayed || 0);
          setOwnedStocks(savedStocks || 0);
          setPassiveIncome(finalPassiveIncome);
          setMoney(finalMoney);
        }
      } catch (e) {
        console.warn("Could not load from localStorage", e);
      } finally {
        setIsLoaded(true);
      }
    };

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
        savedClickUpgrades: ownedClickUpgrades,
        savedPrestigePoints: prestigePoints,
        savedLifetimeEarnings: lifetimeEarnings,
        savedAchievements: unlockedAchievements,
        savedTotalClicks: totalClicks,
        savedTimePlayed: timePlayed,
        savedManagers: ownedManagers,
        savedStocks: ownedStocks,
        savedOfflineCapacityLevel: offlineCapacityLevel,
        savedPrestigePerks: prestigePerks,
        lastSaveTime: Date.now(),
      };
      localStorage.setItem("billionaireSimulatorState", JSON.stringify(state));
    } catch (e) {
      console.warn("Could not save to localStorage", e);
    }
  }, [money, ownedUpgrades, ownedClickUpgrades, prestigePoints, lifetimeEarnings, unlockedAchievements, totalClicks, timePlayed, ownedManagers, ownedStocks, offlineCapacityLevel, prestigePerks, isLoaded]);

  // Check achievements
  useEffect(() => {
    if (!isLoaded) return;
    let newUnlocks = false;
    const currentUnlocks = [...unlockedAchievements];

    for (const achievement of ACHIEVEMENTS) {
      if (!currentUnlocks.includes(achievement.id) && achievement.condition(money, lifetimeEarnings, ownedUpgrades)) {
        currentUnlocks.push(achievement.id);
        newUnlocks = true;
      }
    }

    if (newUnlocks) {
      setTimeout(() => {
        setUnlockedAchievements(currentUnlocks);
        addToast("Achievement Unlocked!");
      }, 0);
    }
  }, [money, lifetimeEarnings, ownedUpgrades, isLoaded, unlockedAchievements]);

  // Golden Investment spawn effect
  useEffect(() => {
    if (!isLoaded || goldenInvestment) return;

    const spawnTimer = setTimeout(() => {
      if (Math.random() > 0.5) {
        const x = Math.max(10, Math.random() * 90);
        const y = Math.max(10, Math.random() * 90);
        const value = Math.max(100, passiveIncome * 60);

        setGoldenInvestment({ x, y, value });

        setTimeout(() => {
          setGoldenInvestment(null);
        }, 10000);
      }
    }, 30000 + Math.random() * 60000);

    return () => clearTimeout(spawnTimer);
  }, [isLoaded, goldenInvestment, passiveIncome]);

  // Passive income and playtime effect
  useEffect(() => {
    if (!isLoaded) return;

    const interval = setInterval(() => {
      setTimePlayed(prev => prev + 1);
      if (passiveIncome > 0) {
        setMoney((prevMoney) => prevMoney + (passiveIncome * prestigeMultiplier));
        setLifetimeEarnings((prevLifetime) => prevLifetime + (passiveIncome * prestigeMultiplier));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [passiveIncome, prestigeMultiplier, isLoaded]);

  // Stock Market simulation effect
  useEffect(() => {
    if (!isLoaded) return;

    const interval = setInterval(() => {
      setStockPrice((prev) => {
        const change = 1 + (Math.random() * 0.3 - 0.15);
        let newPrice = prev * change;

        if (newPrice < 10) newPrice = 10 + Math.random() * 10;
        if (newPrice > 100000) newPrice = 100000 - Math.random() * 10000;

        setStockHistory(history => [...history.slice(1), newPrice]);
        return newPrice;
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [isLoaded]);

  const buyUpgrade = (upgrade: Upgrade) => {
    const currentOwned = ownedUpgrades[upgrade.id] || 0;
    const cost = Math.floor(upgrade.baseCost * Math.pow(1.15, currentOwned));

    if (money >= cost) {
      playSound("buy");
      setMoney((prevMoney) => prevMoney - cost);

      const hasManager = ownedManagers.some(mId => {
        const mgr = MANAGERS.find(m => m.id === mId);
        return mgr && mgr.targetUpgrade === upgrade.id;
      });

      const incomeAdd = hasManager ? upgrade.incomeBoost * 2 : upgrade.incomeBoost;
      setPassiveIncome((prevIncome) => prevIncome + incomeAdd);

      setOwnedUpgrades((prev) => ({
        ...prev,
        [upgrade.id]: currentOwned + 1,
      }));
    }
  };

  const buyClickUpgrade = (upgrade: ClickUpgrade) => {
    const currentOwned = ownedClickUpgrades[upgrade.id] || 0;
    const cost = Math.floor(upgrade.baseCost * Math.pow(1.5, currentOwned));

    if (money >= cost) {
      playSound("buy");
      setMoney((prevMoney) => prevMoney - cost);
      setOwnedClickUpgrades((prev) => ({
        ...prev,
        [upgrade.id]: currentOwned + 1,
      }));
    }
  };

  const getClickUpgradeCost = (upgrade: ClickUpgrade) => {
    const currentOwned = ownedClickUpgrades[upgrade.id] || 0;
    return Math.floor(upgrade.baseCost * Math.pow(1.5, currentOwned));
  };

  const buyManager = (manager: Manager) => {
    if (money >= manager.cost && !ownedManagers.includes(manager.id)) {
      playSound("buy");
      setMoney(prev => prev - manager.cost);
      setOwnedManagers(prev => [...prev, manager.id]);
      addToast(`Hired ${manager.name}!`);

      const targetUpgrade = UPGRADES.find(u => u.id === manager.targetUpgrade);
      const ownedCount = targetUpgrade ? (ownedUpgrades[targetUpgrade.id] || 0) : 0;

      if (targetUpgrade && ownedCount > 0) {
        setPassiveIncome(prev => prev + (targetUpgrade.incomeBoost * ownedCount));
      }
    }
  };

  const buyPrestigePerk = (perkId: string, cost: number) => {
    if (prestigePoints >= cost) {
      playSound("buy");
      setPrestigePoints(prev => prev - cost);
      setPrestigePerks(prev => ({
        ...prev,
        [perkId]: (prev[perkId] || 0) + 1
      }));
    }
  };

  const getUpgradeCost = (upgrade: Upgrade) => {
    const currentOwned = ownedUpgrades[upgrade.id] || 0;
    return Math.floor(upgrade.baseCost * Math.pow(1.15, currentOwned));
  };

  const offlineCapacityCost = Math.floor(1000000 * Math.pow(10, offlineCapacityLevel));
  const buyOfflineCapacity = () => {
    if (money >= offlineCapacityCost) {
      playSound("buy");
      setMoney(prev => prev - offlineCapacityCost);
      setOfflineCapacityLevel(prev => prev + 1);
    }
  };


  const calculatePendingPrestigePoints = () => {
    const PRESTIGE_BASE = 1000000;
    if (lifetimeEarnings < PRESTIGE_BASE) return 0;
    return Math.floor(Math.sqrt(lifetimeEarnings / PRESTIGE_BASE));
  };

  const handlePrestige = () => {
    const newPoints = calculatePendingPrestigePoints();
    if (newPoints > 0) {
      if (window.confirm(`Are you sure you want to prestige? You will gain ${newPoints} prestige points and a +${newPoints * 10}% income bonus, but lose all your money and upgrades.`)) {
        playSound("prestige");
        setPrestigePoints(prev => prev + newPoints);
        setMoney(0);
        setPassiveIncome(0);
        setOwnedUpgrades({});
        setOwnedClickUpgrades({});
        setLifetimeEarnings(0);
      }
    }
  };

  const handleHardReset = () => {
    if (window.confirm("WARNING: This will completely wipe all your progress, achievements, prestige points, and statistics. This cannot be undone. Are you absolutely sure?")) {
      if (window.confirm("LAST CHANCE. Type 'yes' to reset or cancel to abort.") ) {
        localStorage.removeItem("billionaireSimulatorState");
        window.location.reload();
      }
    }
  };

  const pendingPoints = calculatePendingPrestigePoints();

  const [clicks, setClicks] = useState<{ id: number, x: number, y: number, amount: number }[]>([]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  };

  const formatMoney = (amount: number) => {
    if (amount >= 1e12) return `$${(amount / 1e12).toFixed(2)}T`;
    if (amount >= 1e9) return `$${(amount / 1e9).toFixed(2)}B`;
    if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}M`;
    if (amount >= 1e3) return `$${(amount / 1e3).toFixed(2)}K`;

    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const buyStock = () => {
    if (money >= stockPrice) {
      const maxAfford = Math.floor(money / stockPrice);
      const toBuy = Math.max(1, Math.floor(maxAfford * 0.1));

      if (money >= toBuy * stockPrice) {
        playSound("buy");
        setMoney(prev => prev - (toBuy * stockPrice));
        setOwnedStocks(prev => prev + toBuy);
      }
    }
  };

  const sellStock = () => {
    if (ownedStocks > 0) {
      const toSell = Math.max(1, Math.floor(ownedStocks * 0.1));
      setOwnedStocks(prev => prev - toSell);
      const gain = toSell * stockPrice;
      playSound("buy");
      setMoney(prev => prev + gain);
      setLifetimeEarnings(prev => prev + gain);
    }
  };

  const handleWorkClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    playSound("click");
    const amount = clickValue * prestigeMultiplier;
    setMoney((prevMoney) => prevMoney + amount);
    setLifetimeEarnings((prevLifetime) => prevLifetime + amount);
    setTotalClicks((prev) => prev + 1);

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newClick = { id: Date.now() + Math.random(), x, y, amount };
    setClicks(prev => [...prev, newClick]);

    setTimeout(() => {
      setClicks(prev => prev.filter(c => c.id !== newClick.id));
    }, 1000);
  };

  const getWealthTierClass = () => {
    if (lifetimeEarnings >= 1000000000000) return "tier-trillionaire";
    if (lifetimeEarnings >= 1000000000) return "tier-billionaire";
    if (lifetimeEarnings >= 1000000) return "tier-millionaire";
    return "tier-starter";
  };

  return (
    <div className={`game-container ${getWealthTierClass()}`}>
      <div className="toast-container">
        {toasts.map(toast => (
          <div key={toast.id} className="toast">
            {toast.message}
          </div>
        ))}
      </div>

      {goldenInvestment && (
        <button
          className="golden-investment"
          style={{ left: `${goldenInvestment.x}vw`, top: `${goldenInvestment.y}vh` }}
          onClick={() => {
            playSound("prestige");
            const amount = goldenInvestment.value * prestigeMultiplier;
            setMoney(prev => prev + amount);
            setLifetimeEarnings(prev => prev + amount);
            setGoldenInvestment(null);

            const newClick = { id: Date.now() + Math.random(), x: window.innerWidth / 2, y: window.innerHeight / 2, amount };
            setClicks(prev => [...prev, newClick]);
            setTimeout(() => {
              setClicks(prev => prev.filter(c => c.id !== newClick.id));
            }, 1000);
          }}
        >
          🌟
        </button>
      )}

      {showStats && (
        <div className="modal-overlay" onClick={() => setShowStats(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>Statistics</h2>
            <div className="stats-grid">
              <div className="stat-item">
                <span className="stat-label">Total Money Earned:</span>
                <span className="stat-value">{formatMoney(lifetimeEarnings)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Total Clicks:</span>
                <span className="stat-value">{totalClicks.toLocaleString()}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Time Played:</span>
                <span className="stat-value">{formatTime(timePlayed)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Prestige Count:</span>
                <span className="stat-value">{prestigePoints} ({prestigePoints * 10}% bonus)</span>
              </div>
            </div>
            <button className="close-button" onClick={() => setShowStats(false)}>Close</button>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>Settings</h2>
            <div className="settings-section">
              <p>Warning: Hard Reset wipes all local storage data, including prestige points and achievements.</p>
              <button className="hard-reset-button" onClick={handleHardReset}>HARD RESET GAME</button>
            </div>
            <div className="settings-section">
              <h3>Offline Earnings Capacity</h3>
              <p style={{color: "#94a3b8", fontWeight: "normal"}}>Increase your max offline time by 24 hours.</p>
              <p>Current Max: {24 + (offlineCapacityLevel * 24)} Hours</p>
              <button
                className={`upgrade-card click-upgrade-card ${money < offlineCapacityCost ? "disabled" : ""}`}
                onClick={buyOfflineCapacity}
                disabled={money < offlineCapacityCost}
                style={{width: "100%", marginTop: "0.5rem", display: "flex", flexDirection: "column", alignItems: "center"}}
              >
                <span>Upgrade Capacity (+24h)</span>
                <span className="cost">Cost: {formatMoney(offlineCapacityCost)}</span>
              </button>
            </div>

            <button className="close-button" onClick={() => setShowSettings(false)}>Close</button>
          </div>
        </div>
      )}

      <header className="game-header">
        <div className="header-top">
          <h1>Billionaire Simulator</h1>
          <div className="header-buttons">
            <button className="icon-button" onClick={() => setShowStats(true)}>📊 Stats</button>
            <button className="icon-button" onClick={() => setShowSettings(true)}>⚙️ Settings</button>
          </div>
        </div>
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
          <button className="work-button" onClick={handleWorkClick} style={{position: "relative", overflow: "hidden"}}>
            Work
            <span className="click-value">+{formatMoney(clickValue * prestigeMultiplier)}</span>
            {clicks.map(click => (
              <div
                key={click.id}
                className="click-particle"
                style={{ left: click.x, top: click.y }}
              >
                +{formatMoney(click.amount)}
              </div>
            ))}
          </button>
        </section>

        {(lifetimeEarnings > 500000 || prestigePoints > 0) && (
          <section className="prestige-section">
            <h2>Prestige</h2>
            <p className="prestige-desc">Reset progress to gain permanent bonuses.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem", alignItems: "center" }}>
              <button
                className={`prestige-button ${pendingPoints === 0 ? "disabled" : ""}`}
                onClick={handlePrestige}
                disabled={pendingPoints === 0}
              >
                Prestige Now
                <span className="prestige-gain">
                  {pendingPoints > 0 ? `+${pendingPoints} Points` : `Reach ${formatMoney(1000000)} to prestige`}
                </span>
              </button>

              {(prestigePoints > 0 || Object.keys(prestigePerks).length > 0) && (
                <div style={{ marginTop: "1rem", width: "100%" }}>
                  <h3>Prestige Shop</h3>
                  <p>Spend unspent points for permanent multipliers.</p>
                  <div style={{ display: "flex", gap: "1rem", justifyContent: "center", marginTop: "1rem" }}>
                    <div style={{ background: "#3b0764", padding: "1rem", borderRadius: "8px", flex: 1, border: "1px solid #6b21a8" }}>
                      <h4 style={{ margin: "0 0 0.5rem" }}>Click Optimizer</h4>
                      <p style={{ margin: "0 0 0.25rem", fontSize: "0.9rem", color: "#d8b4e2" }}>+50% Base Click Power</p>
                      <p style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>Level: {prestigePerks["clickBoost"] || 0}</p>
                      <button
                        onClick={() => buyPrestigePerk("clickBoost", 1)}
                        disabled={prestigePoints < 1}
                        className={`icon-button ${prestigePoints < 1 ? "disabled" : ""}`}
                        style={{ width: "100%", opacity: prestigePoints < 1 ? 0.5 : 1 }}
                      >
                        Buy (1 Point)
                      </button>
                    </div>
                    <div style={{ background: "#3b0764", padding: "1rem", borderRadius: "8px", flex: 1, border: "1px solid #6b21a8" }}>
                      <h4 style={{ margin: "0 0 0.5rem" }}>Passive Synergy</h4>
                      <p style={{ margin: "0 0 0.25rem", fontSize: "0.9rem", color: "#d8b4e2" }}>+5% Global Income Multiplier</p>
                      <p style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>Level: {prestigePerks["passiveBoost"] || 0}</p>
                      <button
                        onClick={() => buyPrestigePerk("passiveBoost", 2)}
                        disabled={prestigePoints < 2}
                        className={`icon-button ${prestigePoints < 2 ? "disabled" : ""}`}
                        style={{ width: "100%", opacity: prestigePoints < 2 ? 0.5 : 1 }}
                      >
                        Buy (2 Points)
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="stock-market-section">
          <h2>Stock Market</h2>
          <div className="stock-ticker">
            <span className="stock-name">S&P 5000</span>
            <span className={`stock-price ${stockHistory[9] >= stockHistory[8] ? "up" : "down"}`}>
              {formatMoney(stockPrice)}
              {stockHistory[9] >= stockHistory[8] ? " ▲" : " ▼"}
            </span>
          </div>
          <div className="stock-chart">
            {stockHistory.map((val, i) => {
              const max = Math.max(...stockHistory, 1);
              const height = (val / max) * 100;
              return (
                <div key={i} className="chart-bar" style={{ height: `${height}%` }}></div>
              );
            })}
          </div>
          <div className="stock-controls">
            <div className="stock-info">
              <span className="owned-stocks">Owned: {ownedStocks}</span>
              <span className="stock-value">Value: {formatMoney(ownedStocks * stockPrice)}</span>
            </div>
            <div className="stock-actions">
              <button
                className={`stock-buy ${money < stockPrice ? "disabled" : ""}`}
                onClick={buyStock}
                disabled={money < stockPrice}
              >
                Buy (10%)
              </button>
              <button
                className={`stock-sell ${ownedStocks === 0 ? "disabled" : ""}`}
                onClick={sellStock}
                disabled={ownedStocks === 0}
              >
                Sell (10%)
              </button>
            </div>
          </div>
        </section>

        <section className="achievements-section">
          <h2>Achievements ({unlockedAchievements.length} / {ACHIEVEMENTS.length})</h2>
          <div className="achievements-list">
            {ACHIEVEMENTS.map(ach => (
              <div key={ach.id} className={`achievement-badge ${unlockedAchievements.includes(ach.id) ? "unlocked" : "locked"}`} title={ach.description}>
                {ach.name}
              </div>
            ))}
          </div>
        </section>

        <section className="upgrades-section">
          <h2>Managers</h2>
          <div className="upgrades-list">
            {MANAGERS.map(manager => {
              const owned = ownedManagers.includes(manager.id);
              if (owned) return null; // Hide bought managers
              const canAfford = money >= manager.cost;

              return (
                <button
                  key={manager.id}
                  className={`upgrade-card manager-card ${!canAfford ? "disabled" : ""}`}
                  onClick={() => buyManager(manager)}
                  disabled={!canAfford}
                >
                  <div className="upgrade-info">
                    <h3>{manager.name}</h3>
                    <p>{manager.description}</p>
                  </div>
                  <div className="upgrade-action">
                    <span className="cost">Cost: {formatMoney(manager.cost)}</span>
                  </div>
                </button>
              );
            })}
            {ownedManagers.length === MANAGERS.length && (
              <p style={{textAlign: "center", color: "#94a3b8"}}>All managers hired!</p>
            )}
          </div>
        </section>

        <section className="upgrades-section">
          <h2>Click Upgrades</h2>
          <div className="upgrades-list">
            {CLICK_UPGRADES.map((upgrade) => {
              const cost = getClickUpgradeCost(upgrade);
              const canAfford = money >= cost;
              const owned = ownedClickUpgrades[upgrade.id] || 0;

              return (
                <button
                  key={upgrade.id}
                  className={`upgrade-card click-upgrade-card ${!canAfford ? "disabled" : ""}`}
                  onClick={() => buyClickUpgrade(upgrade)}
                  disabled={!canAfford}
                >
                  <div className="upgrade-info">
                    <h3>{upgrade.name}</h3>
                    <p>{upgrade.description}</p>
                    <span className="owned-count">Owned: {owned}</span>
                  </div>
                  <div className="upgrade-action">
                    <span className="cost">Cost: {formatMoney(cost)}</span>
                    <span className="boost">+{formatMoney(upgrade.clickBoost)}/click</span>
                  </div>
                </button>
              );
            })}
          </div>
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
                  className={`upgrade-card ${!canAfford ? "disabled" : ""}`}
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
