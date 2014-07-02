/*global defineSuite*/
defineSuite([
        'DataSources/ModelVisualizer',
        'Core/Cartesian3',
        'Core/JulianDate',
        'DataSources/ConstantPositionProperty',
        'DataSources/ConstantProperty',
        'DataSources/EntityCollection',
        'DataSources/ModelGraphics',
        'Specs/createScene',
        'Specs/destroyScene'
    ], function(
        ModelVisualizer,
        Cartesian3,
        JulianDate,
        ConstantPositionProperty,
        ConstantProperty,
        EntityCollection,
        ModelGraphics,
        createScene,
        destroyScene) {
    "use strict";
    /*global jasmine,describe,xdescribe,it,xit,expect,beforeEach,afterEach,beforeAll,afterAll,spyOn,runs,waits,waitsFor*/

    var duckUrl = './Data/Models/duck/duck.json';

    var scene;
    var visualizer;

    beforeAll(function() {
        scene = createScene();
    });

    afterAll(function() {
        destroyScene(scene);
    });

    afterEach(function() {
        visualizer = visualizer && visualizer.destroy();
    });

    it('constructor throws if no scene is passed.', function() {
        expect(function() {
            return new ModelVisualizer();
        }).toThrowDeveloperError();
    });

    it('update throws if no time specified.', function() {
        var entityCollection = new EntityCollection();
        visualizer = new ModelVisualizer(scene, entityCollection);
        expect(function() {
            visualizer.update();
        }).toThrowDeveloperError();
    });

    it('isDestroy returns false until destroyed.', function() {
        var entityCollection = new EntityCollection();
        visualizer = new ModelVisualizer(scene, entityCollection);
        expect(visualizer.isDestroyed()).toEqual(false);
        visualizer.destroy();
        expect(visualizer.isDestroyed()).toEqual(true);
        visualizer = undefined;
    });

    it('object with no model does not create one.', function() {
        var entityCollection = new EntityCollection();
        visualizer = new ModelVisualizer(scene, entityCollection);

        var testObject = entityCollection.getOrCreateObject('test');
        testObject.position = new ConstantProperty(new Cartesian3(1234, 5678, 9101112));
        visualizer.update(JulianDate.now());
        expect(scene.primitives.length).toEqual(0);
    });

    it('object with no position does not create a model.', function() {
        var entityCollection = new EntityCollection();
        visualizer = new ModelVisualizer(scene, entityCollection);

        var testObject = entityCollection.getOrCreateObject('test');
        var model = testObject.model = new ModelGraphics();
        model.uri = new ConstantProperty(duckUrl);

        visualizer.update(JulianDate.now());
        expect(scene.primitives.length).toEqual(0);
    });

    it('A ModelGraphics causes a primtive to be created and updated.', function() {
        var time = JulianDate.now();
        var entityCollection = new EntityCollection();
        visualizer = new ModelVisualizer(scene, entityCollection);

        var model = new ModelGraphics();
        model.show = new ConstantProperty(true);
        model.scale = new ConstantProperty(2);
        model.minimumPixelSize = new ConstantProperty(24.0);
        model.uri = new ConstantProperty(duckUrl);

        var testObject = entityCollection.getOrCreateObject('test');
        testObject.position = new ConstantPositionProperty(new Cartesian3(1234, 5678, 9101112));
        testObject.model = model;

        visualizer.update(time);

        expect(scene.primitives.length).toEqual(1);

        var primitive = scene.primitives.get(0);
        visualizer.update(time);
        expect(primitive.show).toEqual(true);
        expect(primitive.scale).toEqual(2);
        expect(primitive.minimumPixelSize).toEqual(24.0);
    });

    it('removing removes primitives.', function() {
        var entityCollection = new EntityCollection();
        visualizer = new ModelVisualizer(scene, entityCollection);

        var model = new ModelGraphics();
        model.uri = new ConstantProperty(duckUrl);

        var time = JulianDate.now();
        var testObject = entityCollection.getOrCreateObject('test');
        testObject.position = new ConstantProperty(new Cartesian3(5678, 1234, 1101112));
        testObject.model = model;
        visualizer.update(time);

        expect(scene.primitives.length).toEqual(1);
        visualizer.update(time);
        entityCollection.removeAll();
        visualizer.update(time);
        expect(scene.primitives.length).toEqual(0);
    });

    it('Visualizer sets id property.', function() {
        var entityCollection = new EntityCollection();
        visualizer = new ModelVisualizer(scene, entityCollection);

        var time = JulianDate.now();
        var testObject = entityCollection.getOrCreateObject('test');
        var model = new ModelGraphics();
        testObject.model = model;

        testObject.position = new ConstantProperty(new Cartesian3(5678, 1234, 1101112));
        model.uri = new ConstantProperty(duckUrl);
        visualizer.update(time);

        var modelPrimitive = scene.primitives.get(0);
        expect(modelPrimitive.id).toEqual(testObject);
    });
}, 'WebGL');
