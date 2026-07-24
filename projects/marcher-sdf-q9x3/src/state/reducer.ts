// The editor reducer. All scene mutations flow through here so the renderer only
// ever sees whole, immutable Scene snapshots.

import type {
  Camera,
  Combine,
  Environment,
  Ground,
  Material,
  Post,
  PrimitiveKind,
  Quality,
  Scene,
  Sun,
  Transform,
} from '../scene/types'
import { PRIMITIVES, makeNode, uid } from '../scene/primitives'

export interface EditorState {
  scene: Scene
  selectedId: string | null
}

export type Action =
  | { type: 'select'; id: string | null }
  | { type: 'add'; kind: PrimitiveKind }
  | { type: 'delete'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'move'; id: string; dir: -1 | 1 }
  | { type: 'toggleVisible'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'setParam'; id: string; slot: number; value: number }
  | { type: 'setKind'; id: string; kind: PrimitiveKind }
  | { type: 'patchTransform'; id: string; patch: Partial<Transform> }
  | { type: 'patchMaterial'; id: string; patch: Partial<Material> }
  | { type: 'patchCombine'; id: string; patch: Partial<Combine> }
  | { type: 'patchCamera'; patch: Partial<Camera> }
  | { type: 'patchSun'; patch: Partial<Sun> }
  | { type: 'patchEnv'; patch: Partial<Environment> }
  | { type: 'patchGround'; patch: Partial<Ground> }
  | { type: 'patchQuality'; patch: Partial<Quality> }
  | { type: 'patchPost'; patch: Partial<Post> }
  | { type: 'loadScene'; scene: Scene }

function mapNode(scene: Scene, id: string, fn: (node: Scene['nodes'][number]) => Scene['nodes'][number]): Scene {
  return { ...scene, nodes: scene.nodes.map((n) => (n.id === id ? fn(n) : n)) }
}

export function reducer(state: EditorState, action: Action): EditorState {
  const { scene } = state
  switch (action.type) {
    case 'select':
      return { ...state, selectedId: action.id }

    case 'add': {
      const node = makeNode(action.kind, scene.nodes.length)
      return {
        scene: { ...scene, nodes: [...scene.nodes, node] },
        selectedId: node.id,
      }
    }

    case 'delete': {
      const idx = scene.nodes.findIndex((n) => n.id === action.id)
      if (idx < 0) return state
      const nodes = scene.nodes.filter((n) => n.id !== action.id)
      const next = nodes[idx] ?? nodes[idx - 1] ?? null
      return { scene: { ...scene, nodes }, selectedId: next ? next.id : null }
    }

    case 'duplicate': {
      const idx = scene.nodes.findIndex((n) => n.id === action.id)
      if (idx < 0) return state
      const src = scene.nodes[idx]
      const copy = {
        ...src,
        id: uid(),
        name: `${src.name} copy`,
        params: [...src.params],
        transform: {
          ...src.transform,
          position: [
            src.transform.position[0] + 0.4,
            src.transform.position[1],
            src.transform.position[2] + 0.4,
          ] as [number, number, number],
        },
        material: { ...src.material, color: [...src.material.color] as [number, number, number] },
        combine: { ...src.combine },
      }
      const nodes = [...scene.nodes.slice(0, idx + 1), copy, ...scene.nodes.slice(idx + 1)]
      return { scene: { ...scene, nodes }, selectedId: copy.id }
    }

    case 'move': {
      const idx = scene.nodes.findIndex((n) => n.id === action.id)
      const j = idx + action.dir
      if (idx < 0 || j < 0 || j >= scene.nodes.length) return state
      const nodes = [...scene.nodes]
      const tmp = nodes[idx]
      nodes[idx] = nodes[j]
      nodes[j] = tmp
      return { ...state, scene: { ...scene, nodes } }
    }

    case 'toggleVisible':
      return { ...state, scene: mapNode(scene, action.id, (n) => ({ ...n, visible: !n.visible })) }

    case 'rename':
      return { ...state, scene: mapNode(scene, action.id, (n) => ({ ...n, name: action.name })) }

    case 'setParam':
      return {
        ...state,
        scene: mapNode(scene, action.id, (n) => {
          const params = [...n.params]
          params[action.slot] = action.value
          return { ...n, params }
        }),
      }

    case 'setKind':
      return {
        ...state,
        scene: mapNode(scene, action.id, (n) => ({
          ...n,
          kind: action.kind,
          params: [...PRIMITIVES[action.kind].defaults],
        })),
      }

    case 'patchTransform':
      return {
        ...state,
        scene: mapNode(scene, action.id, (n) => ({
          ...n,
          transform: { ...n.transform, ...action.patch },
        })),
      }

    case 'patchMaterial':
      return {
        ...state,
        scene: mapNode(scene, action.id, (n) => ({
          ...n,
          material: { ...n.material, ...action.patch },
        })),
      }

    case 'patchCombine':
      return {
        ...state,
        scene: mapNode(scene, action.id, (n) => ({
          ...n,
          combine: { ...n.combine, ...action.patch },
        })),
      }

    case 'patchCamera':
      return { ...state, scene: { ...scene, camera: { ...scene.camera, ...action.patch } } }

    case 'patchSun':
      return { ...state, scene: { ...scene, sun: { ...scene.sun, ...action.patch } } }

    case 'patchEnv':
      return { ...state, scene: { ...scene, env: { ...scene.env, ...action.patch } } }

    case 'patchGround':
      return { ...state, scene: { ...scene, ground: { ...scene.ground, ...action.patch } } }

    case 'patchQuality':
      return { ...state, scene: { ...scene, quality: { ...scene.quality, ...action.patch } } }

    case 'patchPost':
      return { ...state, scene: { ...scene, post: { ...scene.post, ...action.patch } } }

    case 'loadScene':
      return { scene: action.scene, selectedId: action.scene.nodes[0]?.id ?? null }

    default:
      return state
  }
}
