import { useState } from 'react';
import PlaygroundLab from './components/PlaygroundLab';
import VisionLab from './components/vision/VisionLab';
import SeqLab from './components/seq/SeqLab';
import GenLab from './components/gen/GenLab';
import DiffLab from './components/diff/DiffLab';
import FlowLab from './components/flow/FlowLab';
import RLLab from './components/rl/RLLab';
import GNNLab from './components/gnn/GNNLab';
import KANLab from './components/kan/KANLab';
import NodeLab from './components/node/NodeLab';
import GANLab from './components/gan/GANLab';
import BayesLab from './components/bayes/BayesLab';
import MoELab from './components/moe/MoELab';
import NCALab from './components/nca/NCALab';
import './App.css';

type Tab = 'playground' | 'vision' | 'transformer' | 'generative' | 'diffusion' | 'flows' | 'adversarial' | 'control' | 'graph' | 'kan' | 'node' | 'uncertainty' | 'moe' | 'morphogenesis';

// Open the lab a shared link points at (#v= vision, #t= transformer, #g= generative, #d= diffusion, #f= flows, #a= GAN, #r= RL, #n= graph, #k= KAN, #o= Neural ODE, #u= uncertainty, #x= MoE, #m= NCA).
function initialTab(): Tab {
  try {
    if (/[#&]m=/.test(location.hash)) return 'morphogenesis';
    if (/[#&]x=/.test(location.hash)) return 'moe';
    if (/[#&]t=/.test(location.hash)) return 'transformer';
    if (/[#&]g=/.test(location.hash)) return 'generative';
    if (/[#&]d=/.test(location.hash)) return 'diffusion';
    if (/[#&]f=/.test(location.hash)) return 'flows';
    if (/[#&]a=/.test(location.hash)) return 'adversarial';
    if (/[#&]r=/.test(location.hash)) return 'control';
    if (/[#&]n=/.test(location.hash)) return 'graph';
    if (/[#&]k=/.test(location.hash)) return 'kan';
    if (/[#&]o=/.test(location.hash)) return 'node';
    if (/[#&]u=/.test(location.hash)) return 'uncertainty';
    return /[#&]v=/.test(location.hash) ? 'vision' : 'playground';
  } catch {
    return 'playground';
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="logo">∇</span>
          <div>
            <h1>Synapse</h1>
            <p>A deep-learning framework from scratch — reverse-mode tensor autograd, live in your browser.</p>
          </div>
        </div>
        <div className="header-right">
          <nav className="tabs">
            <button className={tab === 'playground' ? 'on' : ''} onClick={() => setTab('playground')}>
              2-D Playground
            </button>
            <button className={tab === 'vision' ? 'on' : ''} onClick={() => setTab('vision')}>
              Vision · CNN
            </button>
            <button className={tab === 'transformer' ? 'on' : ''} onClick={() => setTab('transformer')}>
              Transformer · Attention
            </button>
            <button className={tab === 'moe' ? 'on' : ''} onClick={() => setTab('moe')}>
              Sparse · MoE
            </button>
            <button className={tab === 'generative' ? 'on' : ''} onClick={() => setTab('generative')}>
              Generative · VAE
            </button>
            <button className={tab === 'diffusion' ? 'on' : ''} onClick={() => setTab('diffusion')}>
              Diffusion · DDPM
            </button>
            <button className={tab === 'flows' ? 'on' : ''} onClick={() => setTab('flows')}>
              Flows · RealNVP
            </button>
            <button className={tab === 'adversarial' ? 'on' : ''} onClick={() => setTab('adversarial')}>
              Adversarial · GAN
            </button>
            <button className={tab === 'control' ? 'on' : ''} onClick={() => setTab('control')}>
              Control · RL
            </button>
            <button className={tab === 'graph' ? 'on' : ''} onClick={() => setTab('graph')}>
              Graph · GNN
            </button>
            <button className={tab === 'kan' ? 'on' : ''} onClick={() => setTab('kan')}>
              KAN · Splines
            </button>
            <button className={tab === 'node' ? 'on' : ''} onClick={() => setTab('node')}>
              Neural ODE
            </button>
            <button className={tab === 'uncertainty' ? 'on' : ''} onClick={() => setTab('uncertainty')}>
              Uncertainty · Bayes
            </button>
            <button className={tab === 'morphogenesis' ? 'on' : ''} onClick={() => setTab('morphogenesis')}>
              Morphogenesis · NCA
            </button>
          </nav>
          <div className="kbd-hint">
            <kbd>space</kbd> train · <kbd>s</kbd> step · <kbd>r</kbd> reset · <kbd>g</kbd> gradcheck
          </div>
        </div>
      </header>

      {tab === 'playground' ? (
        <PlaygroundLab />
      ) : tab === 'vision' ? (
        <VisionLab />
      ) : tab === 'transformer' ? (
        <SeqLab />
      ) : tab === 'moe' ? (
        <MoELab />
      ) : tab === 'generative' ? (
        <GenLab />
      ) : tab === 'diffusion' ? (
        <DiffLab />
      ) : tab === 'flows' ? (
        <FlowLab />
      ) : tab === 'adversarial' ? (
        <GANLab />
      ) : tab === 'control' ? (
        <RLLab />
      ) : tab === 'graph' ? (
        <GNNLab />
      ) : tab === 'kan' ? (
        <KANLab />
      ) : tab === 'node' ? (
        <NodeLab />
      ) : tab === 'morphogenesis' ? (
        <NCALab />
      ) : (
        <BayesLab />
      )}

      <footer className="foot">
        <span>
          No ML libraries — the tensor autograd, convolutions, pooling, normalization layers, optimizers, schedules,
          losses and datasets are all hand-written. Open <code>src/engine/</code> to read the gradients, or hit{' '}
          <b>Run engine self-test</b> to watch every one of them (including <code>conv2d</code>) get gradchecked.
        </span>
      </footer>
    </div>
  );
}
