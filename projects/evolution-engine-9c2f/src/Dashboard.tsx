import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Settings, Activity, Users, Database } from 'lucide-react';
import { type World } from './engine';

interface DashboardProps {
    world: World;
    onUpdateMutation: (val: number) => void;
    onUpdateFoodSpawn: (val: number) => void;
}

export function Dashboard({ world, onUpdateMutation, onUpdateFoodSpawn }: DashboardProps) {
    const popData = world.stats.populationHistory.map((pop, i) => ({
        time: i,
        population: pop
    }));

    const genData = world.stats.avgGenerationHistory.map((gen, i) => ({
        time: i,
        generation: gen
    }));

    return (
        <div className="w-80 bg-slate-800 text-slate-200 border-l border-slate-700 flex flex-col h-full overflow-y-auto">
            <div className="p-4 border-b border-slate-700">
                <h2 className="text-xl font-bold flex items-center gap-2 text-white">
                    <Activity className="w-5 h-5 text-blue-400" />
                    Evolution Engine
                </h2>
                <p className="text-xs text-slate-400 mt-1">Neural Network Simulation</p>
            </div>

            <div className="p-4 border-b border-slate-700 space-y-4">
                <h3 className="font-semibold text-slate-300 flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    Live Stats
                </h3>
                <div className="grid grid-cols-2 gap-2">
                    <div className="bg-slate-900 p-2 rounded border border-slate-700">
                        <div className="text-xs text-slate-400">Population</div>
                        <div className="text-lg font-mono text-blue-400">{world.entities.length}</div>
                    </div>
                    <div className="bg-slate-900 p-2 rounded border border-slate-700">
                        <div className="text-xs text-slate-400">Food Particles</div>
                        <div className="text-lg font-mono text-green-400">{world.foods.length}</div>
                    </div>
                    <div className="bg-slate-900 p-2 rounded border border-slate-700">
                        <div className="text-xs text-slate-400">Avg Generation</div>
                        <div className="text-lg font-mono text-purple-400">
                            {world.entities.length > 0
                                ? (world.entities.reduce((sum, e) => sum + e.generation, 0) / world.entities.length).toFixed(1)
                                : '0'}
                        </div>
                    </div>
                    <div className="bg-slate-900 p-2 rounded border border-slate-700">
                        <div className="text-xs text-slate-400">Tick</div>
                        <div className="text-lg font-mono text-slate-300">{world.tickCount}</div>
                    </div>
                </div>
            </div>

            <div className="p-4 border-b border-slate-700">
                 <h3 className="font-semibold text-slate-300 flex items-center gap-2 mb-4">
                    <Database className="w-4 h-4" />
                    Metrics
                </h3>
                <div className="h-32 mb-4">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={popData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                            <XAxis dataKey="time" hide />
                            <YAxis stroke="#94a3b8" fontSize={10} width={30} />
                            <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: 'none', borderRadius: '4px' }} />
                            <Line type="monotone" dataKey="population" stroke="#60a5fa" strokeWidth={2} dot={false} isAnimationActive={false} />
                        </LineChart>
                    </ResponsiveContainer>
                    <div className="text-center text-xs text-slate-400 mt-1">Population Timeline</div>
                </div>

                 <div className="h-32">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={genData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                            <XAxis dataKey="time" hide />
                            <YAxis stroke="#94a3b8" fontSize={10} width={30} />
                            <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: 'none', borderRadius: '4px' }} />
                            <Line type="monotone" dataKey="generation" stroke="#c084fc" strokeWidth={2} dot={false} isAnimationActive={false} />
                        </LineChart>
                    </ResponsiveContainer>
                    <div className="text-center text-xs text-slate-400 mt-1">Avg Generation Timeline</div>
                </div>
            </div>

            <div className="p-4 flex-grow">
                 <h3 className="font-semibold text-slate-300 flex items-center gap-2 mb-4">
                    <Settings className="w-4 h-4" />
                    Controls
                </h3>
                <div className="space-y-4">
                    <div>
                        <label className="flex justify-between text-sm text-slate-300 mb-1">
                            <span>Mutation Rate</span>
                            <span>{(world.mutationRate * 100).toFixed(0)}%</span>
                        </label>
                        <input
                            type="range"
                            min="0"
                            max="0.5"
                            step="0.01"
                            value={world.mutationRate}
                            onChange={(e) => onUpdateMutation(parseFloat(e.target.value))}
                            className="w-full accent-blue-500"
                        />
                    </div>
                    <div>
                        <label className="flex justify-between text-sm text-slate-300 mb-1">
                            <span>Food Spawn Rate</span>
                            <span>{world.foodSpawnRate} / tick</span>
                        </label>
                        <input
                            type="range"
                            min="0"
                            max="10"
                            step="1"
                            value={world.foodSpawnRate}
                            onChange={(e) => onUpdateFoodSpawn(parseFloat(e.target.value))}
                            className="w-full accent-green-500"
                        />
                    </div>
                </div>
            </div>
            <div className="p-4 border-t border-slate-700 text-xs text-slate-500 text-center">
                 Scroll to zoom. Drag to pan.
            </div>
        </div>
    );
}
