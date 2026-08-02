import { create } from 'zustand';
import type {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
} from '@xyflow/react';
import {
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';

import { audioCore } from './audio/core';
import { OscillatorWrapper, NoiseWrapper, LfoWrapper, DcOffsetWrapper } from './audio/nodes/sources';
import { GainWrapper, FilterWrapper, DelayWrapper, ReverbWrapper, PanningWrapper, DistortionWrapper, CompressorWrapper, ChorusWrapper, BitcrusherWrapper, TremoloWrapper, RingModulatorWrapper } from './audio/nodes/processors';
import { AnalyserWrapper } from './audio/nodes/visualizers';
import { AdsrWrapper } from './audio/nodes/control';

export type AppNode = Node;

type AppState = {
  nodes: AppNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<AppNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  addNode: (type: string, position: { x: number; y: number }) => void;
  updateNodeData: (id: string, data: Record<string, any>) => void;
  removeNode: (id: string) => void;
  clearAllNodes: () => void;
  triggerNode: (id: string, event: 'attack' | 'release') => void;
  audioNodes: Map<string, any>; // Store instances of wrappers
};

let idCounter = 0;
const getId = () => `node_${idCounter++}`;

export const useStore = create<AppState>((set, get) => ({
  nodes: [
    { id: 'output', type: 'outputNode', position: { x: 500, y: 250 }, data: {} },
  ],
  edges: [],
  audioNodes: new Map(),

  onNodesChange: (changes: NodeChange<AppNode>[]) => {
    set({
      nodes: applyNodeChanges(changes, get().nodes),
    });

    // Handle node deletion
    changes.forEach(change => {
      if (change.type === 'remove') {
        const id = change.id;
        const wrapper = get().audioNodes.get(id);
        if (wrapper && typeof wrapper.destroy === 'function') {
          wrapper.destroy(id);
        }
        get().audioNodes.delete(id);
      }
    });
  },

  onEdgesChange: (changes: EdgeChange[]) => {
    // Process disconnects before state changes
    changes.forEach(change => {
      if (change.type === 'remove') {
        const edge = get().edges.find(e => e.id === change.id);
        if (edge) {
            // handle disconnect
            if (edge.target === 'output') {
                audioCore.disconnectFromDestination(edge.source);
            } else {
                const isParamTarget = edge.targetHandle && edge.targetHandle !== 'in';
                const targetStr = isParamTarget ? `${edge.target}.${edge.targetHandle}` : edge.target;
                audioCore.disconnect(edge.source, targetStr);
            }
        }
      }
    });

    set({
      edges: applyEdgeChanges(changes, get().edges),
    });
  },

  onConnect: (connection: Connection) => {
    set({
      edges: addEdge(connection, get().edges),
    });

    audioCore.resumeContext();

    if (connection.target === 'output') {
        audioCore.connectToDestination(connection.source);
    } else {
        const isParamTarget = connection.targetHandle && connection.targetHandle !== 'in';
        const targetStr = isParamTarget ? `${connection.target}.${connection.targetHandle}` : connection.target;
        audioCore.connect(connection.source, targetStr);
    }
  },

  addNode: (type: string, position: { x: number; y: number }) => {
    const id = getId();
    let wrapper: any = null;
    let initialData = {};

    audioCore.resumeContext();

    switch (type) {
      case 'oscillatorNode':
        wrapper = new OscillatorWrapper(id);
        initialData = { frequency: 440, type: 'sawtooth', detune: 0 };
        break;
      case 'noiseNode':
        wrapper = new NoiseWrapper(id);
        break;
      case 'dcOffsetNode':
        wrapper = new DcOffsetWrapper(id);
        initialData = { offset: 0 };
        break;
      case 'adsrNode':
        wrapper = new AdsrWrapper(id);
        initialData = { attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.3 };
        break;
      case 'lfoNode':
        wrapper = new LfoWrapper(id);
        initialData = { frequency: 5, type: 'sine', depth: 100 };
        break;
      case 'compressorNode':
        wrapper = new CompressorWrapper(id);
        initialData = { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 };
        break;
      case 'bitcrusherNode':
        wrapper = new BitcrusherWrapper(id);
        initialData = { bits: 8 };
        break;
      case 'distortionNode':
        wrapper = new DistortionWrapper(id);
        initialData = { drive: 50 };
        break;
      case 'tremoloNode':
        wrapper = new TremoloWrapper(id);
        initialData = { rate: 5, depth: 0.5 };
        break;
      case 'panningNode':
        wrapper = new PanningWrapper(id);
        initialData = { pan: 0 };
        break;
      case 'gainNode':
        wrapper = new GainWrapper(id);
        initialData = { gain: 0.5 };
        break;
      case 'ringModulatorNode':
        wrapper = new RingModulatorWrapper(id);
        initialData = { frequency: 400, type: 'sine' };
        break;
      case 'filterNode':
        wrapper = new FilterWrapper(id);
        initialData = { frequency: 1000, Q: 1, type: 'lowpass' };
        break;
      case 'chorusNode':
        wrapper = new ChorusWrapper(id);
        initialData = { rate: 1.5, depth: 0.005, mix: 0.5 };
        break;
      case 'delayNode':
        wrapper = new DelayWrapper(id);
        initialData = { delayTime: 0.5, feedback: 0.5 };
        break;
      case 'reverbNode':
        wrapper = new ReverbWrapper(id);
        initialData = { mix: 0.5, decay: 2.0 };
        break;
      case 'analyserNode':
        wrapper = new AnalyserWrapper(id);
        break;
    }

    if (wrapper) {
      get().audioNodes.set(id, wrapper);
    }

    const newNode: AppNode = {
      id,
      type,
      position,
      data: initialData,
    };

    set({ nodes: [...get().nodes, newNode] });
  },

  triggerNode: (id: string, event: 'attack' | 'release') => {
    const wrapper = get().audioNodes.get(id);
    if (wrapper) {
      if (event === 'attack' && typeof wrapper.triggerAttack === 'function') {
        wrapper.triggerAttack();
      } else if (event === 'release' && typeof wrapper.triggerRelease === 'function') {
        wrapper.triggerRelease();
      }
    }
  },

  removeNode: (id: string) => {
    get().onNodesChange([{ type: 'remove', id }]);
  },

  clearAllNodes: () => {
    const nodesToRemove = get().nodes.filter(n => n.id !== 'output').map(n => ({ type: 'remove', id: n.id }));
    get().onNodesChange(nodesToRemove as any);
  },

  updateNodeData: (id: string, data: Record<string, any>) => {
    set({
      nodes: get().nodes.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, ...data } };
        }
        return node;
      }),
    });

    const wrapper = get().audioNodes.get(id);
    if (!wrapper) return;

    // Propagate changes to audio core
    if (wrapper instanceof OscillatorWrapper) {
      if (data.frequency !== undefined) wrapper.setFrequency(data.frequency);
      if (data.type !== undefined) wrapper.setType(data.type);
      if (data.detune !== undefined) wrapper.setDetune(data.detune);
      if (data.octave !== undefined) wrapper.setOctave(data.octave);
      if (data.invertPhase !== undefined) wrapper.setInvertPhase(data.invertPhase);
    } else if (wrapper instanceof LfoWrapper) {
      if (data.frequency !== undefined) wrapper.setFrequency(data.frequency);
      if (data.type !== undefined) wrapper.setType(data.type);
      if (data.depth !== undefined) wrapper.setDepth(data.depth);

    } else if (wrapper instanceof NoiseWrapper) {
      if (data.type !== undefined) wrapper.setType(data.type);
    } else if (wrapper instanceof DcOffsetWrapper) {
      if (data.offset !== undefined) wrapper.setOffset(data.offset);
    } else if (wrapper instanceof GainWrapper) {
      if (data.gain !== undefined) wrapper.setGain(data.gain);
      if (data.muted !== undefined) wrapper.setMute(data.muted);
      if (data.invertPhase !== undefined) wrapper.setInvertPhase(data.invertPhase);
    } else if (wrapper instanceof CompressorWrapper) {
      if (data.threshold !== undefined) wrapper.setThreshold(data.threshold);
      if (data.knee !== undefined) wrapper.setKnee(data.knee);
      if (data.ratio !== undefined) wrapper.setRatio(data.ratio);
      if (data.attack !== undefined) wrapper.setAttack(data.attack);
      if (data.release !== undefined) wrapper.setRelease(data.release);
    } else if (wrapper instanceof DistortionWrapper) {
      if (data.drive !== undefined) wrapper.setDrive(data.drive);
      if (data.mix !== undefined) wrapper.setMix(data.mix);
      if (data.bypass !== undefined) wrapper.setBypass(data.bypass);
    } else if (wrapper instanceof PanningWrapper) {
      if (data.autoPan !== undefined) {
        wrapper.setAutoPan(data.autoPan);
        if (!data.autoPan) {
          const currentNode = get().nodes.find(n => n.id === id);
          if (currentNode && currentNode.data.pan !== undefined) {
            wrapper.setPan(currentNode.data.pan as number);
          } else {
            wrapper.setPan(0);
          }
        } else {
          // ensure depth and rate are applied if just toggled
          const currentNode = get().nodes.find(n => n.id === id);
          if (currentNode) {
            if (currentNode.data.autoPanRate !== undefined) wrapper.setAutoPanRate(currentNode.data.autoPanRate as number);
            if (currentNode.data.autoPanDepth !== undefined) wrapper.setAutoPanDepth(currentNode.data.autoPanDepth as number);
          }
        }
      }
      if (data.autoPanRate !== undefined) wrapper.setAutoPanRate(data.autoPanRate);
      if (data.autoPanDepth !== undefined) wrapper.setAutoPanDepth(data.autoPanDepth);
      if (data.pan !== undefined) wrapper.setPan(data.pan);
    } else if (wrapper instanceof FilterWrapper) {
      if (data.frequency !== undefined) wrapper.setFrequency(data.frequency);
      if (data.Q !== undefined) wrapper.setQ(data.Q);
      if (data.type !== undefined) wrapper.setType(data.type);
      if (data.bypass !== undefined) wrapper.setBypass(data.bypass);
    } else if (wrapper instanceof BitcrusherWrapper) {
      if (data.bits !== undefined) wrapper.setBitDepth(data.bits);
    } else if (wrapper instanceof TremoloWrapper) {
      if (data.rate !== undefined) wrapper.setRate(data.rate);
      if (data.depth !== undefined) wrapper.setDepth(data.depth);
    } else if (wrapper instanceof RingModulatorWrapper) {
      if (data.frequency !== undefined) wrapper.setFrequency(data.frequency);
      if (data.type !== undefined) wrapper.setType(data.type);
    } else if (wrapper instanceof DelayWrapper) {
      if (data.delayTime !== undefined) wrapper.setDelayTime(data.delayTime);
      if (data.feedback !== undefined) wrapper.setFeedback(data.feedback);
      if (data.mix !== undefined) wrapper.setMix(data.mix);
      if (data.bypass !== undefined) wrapper.setBypass(data.bypass);
    } else if (wrapper instanceof ReverbWrapper) {
      if (data.bypass !== undefined) {
        wrapper.setBypass(data.bypass);
        if (!data.bypass) {
          const currentNode = get().nodes.find(n => n.id === id);
          if (currentNode && currentNode.data.mix !== undefined) {
            wrapper.setMix(currentNode.data.mix as number);
          } else {
            wrapper.setMix(0.5);
          }
        }
      }
      if (data.mix !== undefined && !data.bypass) wrapper.setMix(data.mix);
      if (data.decay !== undefined) wrapper.setDecay(data.decay);
    }
  },
}));
