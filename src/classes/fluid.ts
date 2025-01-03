/*
    Fluid, tracer and streamline classes
*/

class Fluid {
    //#region Private variables
    private width: number;
    private height: number;
    private numCells: number;
    private density: number;
    private freeStreamVelocity: number;
    private viscosity: number;
    private timescale: number;

    private distribution: number[][];
    private properties!: FluidProperties;

    private canvas: HTMLCanvasElement;
    private context: CanvasRenderingContext2D;
    private image: ImageData;
    private colourSchemes!: Record<string, ColourMap>;
    private pxPerNode: number;

    private airfoilGridPoints!: Vector[];
    private running: boolean;

    private showTracers: boolean;
    private tracers: Tracer[];
    private showStreamlines: boolean;
    private streamlines: StreamLine[];

    public readonly origin: Vector;
    //#endregion

    constructor(width: number, height: number, density: number, freeStreamVelocity: number, viscosity: number, canvas: HTMLCanvasElement) {
        //#region Basic variables
        this.width = width;
        this.height = height;
        this.numCells = this.width * this.height;
        this.density = density;
        this.freeStreamVelocity = freeStreamVelocity;
        this.viscosity = viscosity;
        this.timescale = (viscosity / (latticeSpeedOfSound ** 2)) + 0.5;
        //#endregion

        //#region Distribution function + local properties
        this.distribution = this.create2DArrayFill(
            this.numCells,
            discreteVelocities,
            1,
        );
        this.setupProperties();
        //#endregion

        //#region Image setup
        this.canvas = canvas;
        this.context = this.canvas.getContext("2d") as CanvasRenderingContext2D;
        this.image = this.context.createImageData(this.canvas.width, this.canvas.height);
        this.setupColourSchemes();
        this.pxPerNode = 2;
        //#endregion

        //#region Airfoil setup
        this.running = true;
        this.airfoilGridPoints = [];
        this.origin = { x: Math.round(this.width / 3 + this.width / 10), y: Math.round(this.height / 2) };
        //#endregion

        //#region Tracers and streamlines
        this.showTracers = false;
        this.showStreamlines = false;
        this.tracers = [];
        this.streamlines = [];
        this.initTracers();
        this.initStreamlines();
        //#endregion
    }

    private index(i: number, j: number): number {
        return getIndex(i, j, this.width);
    }

    //#region Fluid setup + debug
    /**
     * Creates an array of arrays
     * @param rows Number of rows
     * @param columns Number of columns
     * @param fill The initial value for every element in the array
     */
    private create2DArrayFill(rows: number, columns: number, fill: number): number[][] {
        let arr = new Array(rows);
        for (let i = 0; i < rows; i++) {
            arr[i] = new Array(columns).fill(fill);
        }
        return arr;
    }
    private setupProperties(): void {
        this.properties = {
            localDensity: new Array(this.numCells).fill(this.density),
            localVelocity: new Array(this.numCells).fill({ x: 0, y: 0 }),
            localPressure: new Array(this.numCells).fill(0),
            pressureGradient: new Array(this.numCells).fill({ x: 0, y: 0 }),
            localCurl: new Array(this.numCells).fill(0),
            solid: new Array(this.numCells).fill(false)
        }
    }

    public initFluid(): void {
        let velocityVector: Vector = { x: this.freeStreamVelocity, y: 0 };
        for (let nodeIndex = 0; nodeIndex < this.numCells; nodeIndex++) {
            for (let i = 0; i < discreteVelocities; i++) {
                this.distribution[nodeIndex][i] = this.getEquilibrium(latticeWeights[i], this.density, velocityVector, i);
            }
        }
    }

    public runMainLoop(): void {
        if (this.running) {
            this.computeMoments();
            this.applyBoundaryConditions();
            this.collideLocally();
            this.stream();

            this.computePressureGradient();
            if (this.showTracers) this.moveTracers();
        }
    }
    //#endregion

    //#region Getters
    get PressureGradient(): Vector[] {
        return this.properties.pressureGradient;
    }
    get Dimensions(): Vector {
        return { x: this.width, y: this.height };
    }
    get VelocityField(): Vector[] {
        return this.properties.localVelocity;
    }
    get PressureField(): number[] {
        return this.properties.localPressure;
    }
    get FreeStreamVelocity(): number {
        return this.freeStreamVelocity;
    }
    get Density(): number {
        return this.density;
    }
    get Solid(): boolean[] {
        return this.properties.solid;
    }
    //#endregion

    //#region Setters
    set ShowTracers(value: boolean) {
        this.showTracers = value;
    }
    set ShowStreamlines(value: boolean) {
        this.showStreamlines = value;
    }
    set FreeStreamVelocity(value: number) {
        this.freeStreamVelocity = value;
        this.initFluid();
    }
    //#endregion

    //#region Main loop functions
    private getEquilibrium(weight: number, rho: number, velocityVector: Vector, latticeIndex: number): number {
        let latticeVector: Vector = { x: latticeXs[latticeIndex], y: latticeYs[latticeIndex] };
        let latticeDotU = dotVectors(latticeVector, velocityVector);
        let uDotU = dotVectors(velocityVector, velocityVector);

        return weight * rho * (1 + 3 * latticeDotU +
            (9 / 2) * latticeDotU ** 2 -
            (3 / 2) * uDotU);
    }

    private computeCurl(): void {
        //Finite differences method
        for (let y = 1; y < this.height - 1; y++) {
            for (let x = 1; x < this.width - 1; x++) {
                //Partial derivatives
                let dYVelocityOverDx: number =
                    this.properties.localVelocity[this.index(x + 1, y)].y -
                    this.properties.localVelocity[this.index(x - 1, y)].y
                let dXVelocityOverDy: number =
                    this.properties.localVelocity[this.index(x, y + 1)].x -
                    this.properties.localVelocity[this.index(x, y - 1)].x;

                this.properties.localCurl[this.index(x, y)] = dYVelocityOverDx - dXVelocityOverDy;
            }
        }
    }

    private computePressureGradient(): void {
        //Finite differences method - same as curl
        for (let y = 1; y < this.height - 1; y++) {
            for (let x = 1; x < this.width - 1; x++) {
                //Partial derivatives
                let dPressureOverDx: number =
                    this.properties.localPressure[this.index(x + 1, y)] -
                    this.properties.localPressure[this.index(x - 1, y)]
                let dPressureOverDy: number =
                    this.properties.localPressure[this.index(x, y + 1)] -
                    this.properties.localPressure[this.index(x, y - 1)];

                this.properties.pressureGradient[this.index(x, y)] = {
                    x: dPressureOverDx / 2,
                    y: dPressureOverDy / 2
                };
            }
        }
    }

    private computeMoments(): void {
        //Arrow functions
        const summation = (arr: number[]) => arr.reduce((acc, val) => acc + val, 0);
        const mapToLat = (arr: number[], lat: number[]) => arr.map((val, i) => val * lat[i]);
        for (let nodeIndex = 0; nodeIndex < this.numCells; nodeIndex++) {
            let nodeDist = this.distribution[nodeIndex];
            let nodeDensity = summation(nodeDist);

            //Velocity
            this.properties.localVelocity[nodeIndex] = {
                x: summation(mapToLat(nodeDist, latticeXs)) / nodeDensity,
                y: summation(mapToLat(nodeDist, latticeYs)) / nodeDensity
            }

            //Density
            this.properties.localDensity[nodeIndex] = nodeDensity;

            //Pressure
            this.properties.localPressure[nodeIndex] = (latticeSpeedOfSound ** 2) * nodeDensity;
        }
    }

    private applyBoundaryConditions(): void {
        for (let x = 0; x < this.width - 2; x++) {
            for (let y = 0; y < this.height - 2; y++) {
                if (this.properties.solid[this.index(x, y)]) {
                    //Reflect fluid distribution
                    this.distribution[this.index(x, y)] = oppositeIndices.map(
                        (index) => this.distribution[this.index(x, y)][index],
                    );

                    //Set velocity to 0
                    this.properties.localVelocity[this.index(x, y)] = { x: 0, y: 0 };
                }
            }
        }
    }

    private collideLocally(): void {
        for (let nodeIndex = 0; nodeIndex < this.numCells; nodeIndex++) {
            for (let i of latticeIndices) {
                let localDensity = this.properties.localDensity[nodeIndex];
                let localVelocity: Vector = this.properties.localVelocity[nodeIndex];
                let latticeWeight = latticeWeights[i];

                this.distribution[nodeIndex][i] =
                    this.distribution[nodeIndex][i] -
                    (1 / this.timescale) *
                    (this.distribution[nodeIndex][i] -
                        this.getEquilibrium(latticeWeight, localDensity, localVelocity, i));
            }
        }
    }

    private streamInDirection(x: number, y: number, direction: Directions) {
        let offset: Vector = { x: -latticeXs[direction], y: -latticeYs[direction] };
        this.distribution[this.index(x, y)][direction] = this.distribution[this.index(x + offset.x, y + offset.y)][direction];
    }

    /**
     * Credit: 
     */
    private stream(): void {
        //North west and north - 8 and 1
        for (let y = this.height - 2; y > 0; y--) {
            for (let x = 1; x < this.width - 1; x++) {
                //nw
                this.streamInDirection(x, y, Directions.NorthWest);
                //n
                this.streamInDirection(x, y, Directions.North);
            }
        }

        //north east and east - 2 and 3
        for (let y = this.height - 2; y > 0; y--) {
            for (let x = this.width - 2; x > 0; x--) {
                //ne
                this.streamInDirection(x, y, Directions.NorthEast);
                //e
                this.streamInDirection(x, y, Directions.East);
            }
        }

        //south east and south - 4 and 5
        for (let y = 1; y < this.height - 1; y++) {
            for (let x = this.width - 2; x > 0; x--) {
                //se
                this.streamInDirection(x, y, Directions.SouthEast);
                //s
                this.streamInDirection(x, y, Directions.South);

            }
        }

        //south west and west
        for (let y = 1; y < this.height - 1; y++) {
            for (let x = 1; x < this.width - 1; x++) {
                //sw
                this.streamInDirection(x, y, Directions.SouthWest);
                //w
                this.streamInDirection(x, y, Directions.West);
            }
        }
    }
    //#endregion

    //#region Tracers and streamlines
    private initTracers(): void {
        let rows = 8;
        let columns = 8;
        let xOffset = Math.round(this.width / columns);
        let yOffset = Math.round(this.height / rows);
        let bounds: Bound = { lower: 1, upper: this.width };

        for (let x = 0; x < columns; x++) {
            for (let y = 0; y < rows; y++) {
                let position: Vector = { x: x * xOffset + xOffset / 2, y: y * yOffset + yOffset / 2 };
                this.tracers.push(new Tracer(position, bounds));
            }
        }
    }

    private initStreamlines(): void {
        let rows = 10;
        let columns = 10;
        let xOffset = this.width / columns;
        let yOffset = this.height / rows;

        for (let x = 0; x < columns - 1; x++) {
            for (let y = 0; y < rows; y++) {
                let position: Vector = { x: x * xOffset + xOffset / 2, y: y * yOffset + yOffset / 2 };
                this.streamlines.push(new StreamLine(position, 0.01));
            }
        }
    }

    private clearTracers(): void {
        while (this.tracers.length) {
            this.tracers.pop();
        }
    }

    private clearStreamlines(): void {
        while (this.streamlines.length) {
            this.streamlines.pop();
        }
    }

    private moveTracers(): void {
        for (let tracer of this.tracers) {
            let testPosition = tracer.Position;
            let roundedPos = roundVector(testPosition)
            if (testPosition.x >= this.width || this.properties.solid[this.index(roundedPos.x, roundedPos.y)]) {
                tracer.resetPosition();
                testPosition.x = 1;
            }
            let velocity: Vector = this.sampleVelocity(testPosition);
            tracer.Velocity = velocity;
            tracer.move();
        }
    }

    /**
     * Credit: https://matthias-research.github.io/pages/tenMinutePhysics/17-fluidSim.pdf
     * @param samplePosition The position to be sampled
     */
    private sampleVelocity(samplePosition: Vector): Vector {
        //Bilinear interpolation
        let x = samplePosition.x;
        let y = samplePosition.y;

        //Find the 4 surrounding points
        let x1 = Math.floor(x);
        let x2 = Math.ceil(x);
        let y1 = Math.floor(y);
        let y2 = Math.ceil(y);

        //Avoid divide by 0 errors when x and y are integers
        if (x1 === x2) x2++;
        if (y1 === y2) y2++;

        //Get fractional distances
        let dx = (x - x1) / (x2 - x1);
        let dy = (y - y1) / (y2 - y1);

        //Get velocities
        let topLeft = this.properties.localVelocity[this.index(x1, y1)];
        let topRight = this.properties.localVelocity[this.index(x2, y1)];
        let bottomLeft = this.properties.localVelocity[this.index(x1, y2)];
        let bottomRight = this.properties.localVelocity[this.index(x2, y2)];

        //Interpolate
        let xVelocity =
            ((1 - dx) * (1 - dy) * topLeft.x) +
            (dx * (1 - dy) * topRight.x) +
            ((1 - dx) * dy * bottomLeft.x) +
            (dx * dy * bottomRight.x);

        let yVelocity =
            ((1 - dx) * (1 - dy) * topLeft.y) +
            (dx * (1 - dy) * topRight.y) +
            ((1 - dx) * dy * bottomLeft.y) +
            (dx * dy * bottomRight.y);

        return { x: xVelocity, y: yVelocity };
    }
    //#endregion

    //#region Drawing functions
    private gridPosToImagePos(gridPosition: Vector): Vector {
        //Flipping the y-position
        return { x: gridPosition.x, y: this.height - gridPosition.y - 1 }
    }

    private setupColourSchemes(): void {
        //Setting up colour schemes for the simulation
        this.colourSchemes = {
            fire: new ColourMap([
                getColour(0, 0, 0, 255),
                getColour(127, 0, 0, 255),
                getColour(255, 0, 0, 255),
                getColour(255, 255, 0, 255),
                getColour(255, 255, 255, 255)],
                [200, 50, 75, 50]),
            rainbow: new ColourMap([
                getColour(0, 0, 128, 255),
                getColour(0, 0, 255, 255),
                getColour(0, 255, 255, 255),
                getColour(255, 255, 0, 255),
                getColour(255, 0, 0, 255),
                getColour(128, 0, 0, 255)],
                [50, 50, 50, 50, 50]),
            greyscale: new ColourMap([
                getColour(0, 0, 0, 255),
                getColour(100, 100, 100, 255),
                getColour(170, 170, 170, 255),
                getColour(255, 255, 255, 255)],
                [200, 50, 200])
        }
    }

    private getColourFromMode(simulationMode: SimulationMode, index: number, contrast: number): Colour {
        let colourIndex = 0;
        let colourScheme: ColourMap = this.colourSchemes.fire;  //Default scheme

        //Different colouring modes and different graphing modes
        switch (simulationMode) {
            case 'velocity':
                let velocityMagnitude = absoluteVector(this.properties.localVelocity[index]);
                colourIndex = Math.round(colourScheme.NumColours * (velocityMagnitude * 4 * contrast));
                break;
            case 'density':
                let density = this.properties.localDensity[index];
                colourIndex = Math.round(colourScheme.NumColours * ((density - this.density) * 8 * contrast + 0.5));
                break;
            case 'curl':
                let curl = this.properties.localCurl[index];
                colourScheme = this.colourSchemes.greyscale;
                colourIndex = Math.round(colourScheme.NumColours * (curl * 5 * contrast + 0.5));
                break;
            case 'pressure':
                //Since pressure is directly proportional to density
                let pressure = this.properties.localPressure[index];
                colourIndex = Math.round(colourScheme.NumColours * ((3 * pressure - this.density) * 5 * contrast + 0.5));
                break;
            case 'pressureGradient':
                let pressureGradient = absoluteVector(this.properties.pressureGradient[index]);
                colourScheme = this.colourSchemes.rainbow;
                colourIndex = Math.round(colourScheme.NumColours * ((5 * pressureGradient) * 10 * contrast + 0.35));
                break;
            default:
                console.log("Error");
                break;
        }

        //Dealing with out of bounds errors
        return colourScheme.Map[enforceBounds(colourIndex, colourScheme.Bounds)];
    }

    public drawFluid(simulationMode: SimulationMode): void {
        if (simulationMode === 'curl') this.computeCurl();

        for (let y = 1; y < this.height - 1; y++) {
            for (let x = 1; x < this.width - 1; x++) {
                let index = this.index(x, y);
                let colour: Colour = { red: 255, green: 255, blue: 255, alpha: 255 };
                let contrast = Math.pow(1.2, 1);

                if (this.properties.solid[index]) {
                    colour = { red: 68, green: 71, blue: 90, alpha: 255 };  //Solid
                } else {
                    colour = this.getColourFromMode(simulationMode, index, contrast);
                }
                let position = { x: x, y: y };
                this.colourPixel(position, colour);
            }
        }

        //Drawing order
        this.context.putImageData(this.image, 0, 0);
        if (this.showTracers) this.drawTracers();
        if (this.showStreamlines) this.drawStreamlines();
    }

    /**
     * Credit: https://matthias-research.github.io/pages/tenMinutePhysics/17-fluidSim.pdf
     */
    private drawStreamlines(): void {
        let velocityScale = 10;
        let simulationScale = this.pxPerNode;
        this.context.strokeStyle = "#202020";
        this.context.lineWidth = 1;

        for (let streamline of this.streamlines) {
            this.context.beginPath();

            let currentPosition = streamline.position;
            let imagePosition = this.gridPosToImagePos(currentPosition);

            this.context.moveTo(simulationScale * imagePosition.x, simulationScale * imagePosition.y);

            for (let n = 0; n < streamline.maxSteps; n++) {
                let velocityVector = scaleVector(this.sampleVelocity(currentPosition), velocityScale);
                currentPosition = addVectors(currentPosition, velocityVector);

                imagePosition = this.gridPosToImagePos(currentPosition);

                if (imagePosition.x >= this.width - 1 || imagePosition.x <= 0 || imagePosition.y >= this.height || imagePosition.y <= 0) break;

                this.context.lineTo(simulationScale * imagePosition.x, simulationScale * imagePosition.y);
            }

            this.context.stroke();
            this.context.closePath();
        }
    }

    private drawTracers(): void {
        let simulationScale = this.pxPerNode;
        this.context.fillStyle = "#282A36";
        for (let tracer of this.tracers) {
            let position = this.gridPosToImagePos(tracer.Position);
            this.context.fillRect(simulationScale * position.x, simulationScale * position.y, this.pxPerNode, this.pxPerNode);
        }
    }

    private colourPixel(position: Vector, colour: Colour): void {
        let pxPerNd = this.pxPerNode;
        let imagePosition = this.gridPosToImagePos(position);
        let x = imagePosition.x;
        let y = imagePosition.y;

        for (let pixelY = y * pxPerNd; pixelY < (y + 1) * pxPerNd; pixelY++) {
            for (let pixelX = x * pxPerNd; pixelX < (x + 1) * pxPerNd; pixelX++) {
                let imageIndex = (pixelX + pixelY * this.image.width) * 4;
                this.image.data[imageIndex] = colour.red;
                this.image.data[imageIndex + 1] = colour.green;
                this.image.data[imageIndex + 2] = colour.blue;
                this.image.data[imageIndex + 3] = colour.alpha;
            }
        }
    }
    //#endregion

    //#region Airfoil functions
    private setupObstacle(): void {
        //Reset solid
        this.properties.solid = new Array(this.numCells).fill(false);

        for (let i = 0; i < this.airfoilGridPoints.length; i++) {
            let point = this.airfoilGridPoints[i];
            let index = this.index(this.origin.x + point.x, this.origin.y + point.y);
            this.properties.solid[index] = true;
        }
    }

    public updateAirfoil(newGridPoints: Vector[]): void {
        this.airfoilGridPoints = newGridPoints;
        this.clearTracers();
        this.clearStreamlines();
        this.initTracers();
        this.initStreamlines();
        this.setupObstacle();
    }
    //#endregion
}

//#region Tracer and Streamline
class Tracer {
    private position: Vector;
    private velocity: Vector;
    private xBounds: Bound;

    constructor(startPosition: Vector, xBounds: Bound) {
        this.position = startPosition;
        this.velocity = { x: 0, y: 0 };
        this.xBounds = xBounds;
    }

    set Velocity(newVelocity: Vector) {
        this.velocity = newVelocity;
    }

    get Position(): Vector {
        return this.position;
    }

    public resetPosition(): void {
        this.position.x = this.xBounds.lower;
    }

    public move(): void {
        this.position = addVectors(this.position, this.velocity);

        if (Math.round(this.position.x) >= this.xBounds.upper - 1) {
            //Tracer has gone outside the map
            this.resetPosition();
        }
    }

}

class StreamLine {
    public readonly position: Vector;
    public readonly stepSize: number;
    public readonly maxSteps: number;

    constructor(startPosition: Vector, stepSize: number) {
        this.position = startPosition;
        this.stepSize = stepSize;
        this.maxSteps = 10;
    }
}
//#endregion