import { Vector2D, random } from './math';
import { NeuralNetwork } from './neural';

export class Entity {
    position: Vector2D;
    velocity: Vector2D;
    acceleration: Vector2D;
    radius: number;
    maxSpeed: number;
    maxForce: number;

    health: number;
    maxHealth: number;
    energy: number;
    maxEnergy: number;

    brain: NeuralNetwork;

    color: string;
    generation: number;
    age: number;

    constructor(x: number, y: number, brain?: NeuralNetwork) {
        this.position = new Vector2D(x, y);
        this.velocity = new Vector2D(random(-1, 1), random(-1, 1));
        this.acceleration = new Vector2D(0, 0);

        this.radius = 5;
        this.maxSpeed = 3;
        this.maxForce = 0.1;

        this.maxHealth = 100;
        this.health = this.maxHealth;
        this.maxEnergy = 100;
        this.energy = this.maxEnergy;

        this.generation = 1;
        this.age = 0;

        // Inputs:
        // 0: Distance to nearest food
        // 1: Angle to nearest food
        // 2: Distance to nearest entity
        // 3: Angle to nearest entity
        // 4: Own energy level
        // 5: Own health level
        // Outputs:
        // 0: Desired speed
        // 1: Desired rotation (angle change)
        if (brain) {
            this.brain = brain.clone();
        } else {
            this.brain = new NeuralNetwork(6, 8, 2);
        }

        // Color based on weights, just a fun visual representation of "genes"
        const r = Math.floor((this.brain.weightsIH[0][0] + 1) / 2 * 255);
        const g = Math.floor((this.brain.weightsIH[0][1] + 1) / 2 * 255);
        const b = Math.floor((this.brain.weightsIH[0][2] + 1) / 2 * 255);
        this.color = `rgb(${r}, ${g}, ${b})`;
    }

    applyForce(force: Vector2D) {
        this.acceleration = this.acceleration.add(force);
    }

    update(worldWidth: number, worldHeight: number) {
        this.velocity = this.velocity.add(this.acceleration);
        this.velocity = this.velocity.limit(this.maxSpeed);
        this.position = this.position.add(this.velocity);
        this.acceleration = new Vector2D(0, 0); // Reset acceleration

        this.age++;

        // Passive energy drain
        this.energy -= 0.1;

        // Wrap around edges
        if (this.position.x > worldWidth) this.position.x = 0;
        if (this.position.x < 0) this.position.x = worldWidth;
        if (this.position.y > worldHeight) this.position.y = 0;
        if (this.position.y < 0) this.position.y = worldHeight;
    }

    think(nearestFood: Vector2D | null, nearestEntity: Entity | null) {
        const inputs = [0, 0, 0, 0, this.energy / this.maxEnergy, this.health / this.maxHealth];

        if (nearestFood) {
            const dx = nearestFood.x - this.position.x;
            const dy = nearestFood.y - this.position.y;
            inputs[0] = Math.sqrt(dx*dx + dy*dy) / 1000; // Normalized distance approx
            inputs[1] = Math.atan2(dy, dx) / Math.PI; // Normalized angle
        }

        if (nearestEntity) {
            const dx = nearestEntity.position.x - this.position.x;
            const dy = nearestEntity.position.y - this.position.y;
            inputs[2] = Math.sqrt(dx*dx + dy*dy) / 1000;
            inputs[3] = Math.atan2(dy, dx) / Math.PI;
        }

        const outputs = this.brain.feedForward(inputs);

        // Output 0 maps to speed multiplier (-1 to 1, we map to 0 to 1 for forward only, or allow slight reverse)
        const speed = (outputs[0] + 1) / 2 * this.maxSpeed;

        // Output 1 maps to rotation angle
        const currentAngle = Math.atan2(this.velocity.y, this.velocity.x);
        const rotation = outputs[1] * Math.PI / 4; // Max rotation per tick

        const newAngle = currentAngle + rotation;
        const desiredVelocity = new Vector2D(Math.cos(newAngle) * speed, Math.sin(newAngle) * speed);

        const steer = desiredVelocity.sub(this.velocity);
        steer.limit(this.maxForce);
        this.applyForce(steer);
    }

    reproduce(): Entity {
        const childBrain = this.brain.clone();
        childBrain.mutate(0.1); // 10% mutation rate
        const child = new Entity(this.position.x, this.position.y, childBrain);
        child.generation = this.generation + 1;
        // Share energy
        this.energy -= this.maxEnergy / 2;
        child.energy = this.maxEnergy / 2;
        return child;
    }
}

export class World {
    width: number;
    height: number;
    entities: Entity[];
    foods: Vector2D[];

    tickCount: number;

    mutationRate: number = 0.1;
    foodSpawnRate: number = 2; // per tick

    stats: {
        populationHistory: number[];
        avgGenerationHistory: number[];
    };

    constructor(width: number, height: number, initialEntities: number, initialFood: number) {
        this.width = width;
        this.height = height;
        this.entities = [];
        this.foods = [];
        this.tickCount = 0;

        this.stats = {
            populationHistory: [],
            avgGenerationHistory: []
        };

        for (let i = 0; i < initialEntities; i++) {
            this.entities.push(new Entity(random(0, this.width), random(0, this.height)));
        }

        for (let i = 0; i < initialFood; i++) {
            this.foods.push(new Vector2D(random(0, this.width), random(0, this.height)));
        }
    }

    update() {
        this.tickCount++;

        // Spawn food
        for (let i = 0; i < this.foodSpawnRate; i++) {
             if (Math.random() < 0.5) { // Slow it down a bit
                 this.foods.push(new Vector2D(random(0, this.width), random(0, this.height)));
             }
        }

        const newEntities: Entity[] = [];

        for (let i = this.entities.length - 1; i >= 0; i--) {
            const entity = this.entities[i];

            // Find nearest food (O(n) naively, spatial partition later for optimization)
            let nearestFood: Vector2D | null = null;
            let minFoodDistSq = Infinity;
            let foodIndex = -1;

            for (let j = 0; j < this.foods.length; j++) {
                const distSq = entity.position.dist(this.foods[j]); // simplified dist check
                if (distSq < minFoodDistSq) {
                    minFoodDistSq = distSq;
                    nearestFood = this.foods[j];
                    foodIndex = j;
                }
            }

            // Find nearest entity
            let nearestEntity: Entity | null = null;
            let minEntityDistSq = Infinity;

            for (let j = 0; j < this.entities.length; j++) {
                if (i !== j) {
                    const distSq = entity.position.dist(this.entities[j].position);
                    if (distSq < minEntityDistSq) {
                        minEntityDistSq = distSq;
                        nearestEntity = this.entities[j];
                    }
                }
            }

            // Eat food if close enough
            if (nearestFood && minFoodDistSq < 15) {
                this.foods.splice(foodIndex, 1);
                entity.energy = Math.min(entity.energy + 20, entity.maxEnergy);
            }

            // Think and move
            entity.think(nearestFood, nearestEntity);
            entity.update(this.width, this.height);

            // Reproduce
            if (entity.energy > entity.maxEnergy * 0.8 && entity.age > 100) {
                newEntities.push(entity.reproduce());
            }

            // Die
            if (entity.energy <= 0 || entity.health <= 0) {
                this.entities.splice(i, 1);
                // Turn into food
                this.foods.push(new Vector2D(entity.position.x, entity.position.y));
            }
        }

        this.entities.push(...newEntities);

        // Cap max entities to prevent freezing
        if (this.entities.length > 500) {
            // Kill oldest/weakest to maintain balance roughly
            this.entities.sort((a, b) => a.energy - b.energy);
            this.entities.splice(0, this.entities.length - 500);
        }

        if (this.foods.length > 2000) {
             this.foods.splice(0, this.foods.length - 2000);
        }

        // Record stats occasionally
        if (this.tickCount % 60 === 0) {
            this.stats.populationHistory.push(this.entities.length);
            if (this.stats.populationHistory.length > 50) this.stats.populationHistory.shift();

            let avgGen = 0;
            if (this.entities.length > 0) {
                 avgGen = this.entities.reduce((sum, e) => sum + e.generation, 0) / this.entities.length;
            }
            this.stats.avgGenerationHistory.push(avgGen);
            if (this.stats.avgGenerationHistory.length > 50) this.stats.avgGenerationHistory.shift();
        }
    }
}
