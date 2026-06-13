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
import { OscillatorWrapper, NoiseWrapper, LfoWrapper } from './audio/nodes/sources';
import { GainWrapper, FilterWrapper, DelayWrapper, ReverbWrapper } from './audio/nodes/processors';
import { AnalyserWrapper } from './audio/nodes/visualizers';

export type AppNode = Node;

type AppState = {
  nodes: AppNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<AppNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  addNode: (type: string, position: { x: number; y: number }) => void;
  updateNodeData: (id: string, data: Record<string, any>) => void;
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
        initialData = { frequency: 440, type: 'sawtooth' };
        break;
      case 'noiseNode':
        wrapper = new NoiseWrapper(id);
        break;
      case 'lfoNode':
        wrapper = new LfoWrapper(id);
        initialData = { frequency: 5, type: 'sine', depth: 100 };
        break;
      case 'gainNode':
        wrapper = new GainWrapper(id);
        initialData = { gain: 0.5 };
        break;
      case 'filterNode':
        wrapper = new FilterWrapper(id);
        initialData = { frequency: 1000, Q: 1, type: 'lowpass' };
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
    } else if (wrapper instanceof LfoWrapper) {
      if (data.frequency !== undefined) wrapper.setFrequency(data.frequency);
      if (data.type !== undefined) wrapper.setType(data.type);
      if (data.depth !== undefined) wrapper.setDepth(data.depth);
    } else if (wrapper instanceof GainWrapper) {
      if (data.gain !== undefined) wrapper.setGain(data.gain);
    } else if (wrapper instanceof FilterWrapper) {
      if (data.frequency !== undefined) wrapper.setFrequency(data.frequency);
      if (data.Q !== undefined) wrapper.setQ(data.Q);
      if (data.type !== undefined) wrapper.setType(data.type);
    } else if (wrapper instanceof DelayWrapper) {
      if (data.delayTime !== undefined) wrapper.setDelayTime(data.delayTime);
      if (data.feedback !== undefined) wrapper.setFeedback(data.feedback);
    } else if (wrapper instanceof ReverbWrapper) {
      if (data.mix !== undefined) wrapper.setMix(data.mix);
      if (data.decay !== undefined) wrapper.setDecay(data.decay);
    }
  },
}));
