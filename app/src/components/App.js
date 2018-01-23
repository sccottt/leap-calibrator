
// Imports

import * as _ from 'lodash';
import * as React from 'react';
import * as mkdirp from 'mkdirp';
import * as rimraf from 'rimraf';
import { remote } from 'electron';
import * as Leap from 'leapjs';

import screenfull from 'screenfull';
import classNames from 'classnames';

import { maths, net, random, Rect, Span } from 'varyd-utils';
import LeapAgent from '../utils/LeapAgent';

import Heatmap from './Heatmap';
import ControlsPanel from './ControlsPanel';
import HandsDisplay from './HandsDisplay';
import Calibration from './Calibration';


// Constants

const electronFs  = remote.require('fs'),
      electronApp = remote.app,
      electronWin = remote.getCurrentWindow();

const CALIBRATION_STEPS       = 4;

const FILENAME_CONFIG         = 'config.json',
      FILENAME_CONFIG_DEFAULT = 'config.default.json';


// Class

export default class App extends React.Component {

  // Constructor

  constructor() {

    super();

    this.initBindings();
    this.initDocsFolder();
    this.initState();
    this.initFullscreen();
    this.initHeatmap()

    this.initConfig();

  }

  initState() {

    this.state = {

      ready: false,

      hands: [],

      fullscreen: true,

      appMinX: undefined,
      appMinY: undefined,
      appMaxX: undefined,
      appMaxY: undefined,

      showHeatmap: false,
      showLeapZone: false,

      leapMinX: 0,
      leapMinY: 0,
      leapMaxX: 1,
      leapMaxY: 1,

      isCalibrating: false,
      calibrationStep: -1,
      calibrationReady: false,
      calibrationRegistering: false,

      winW: window.innerWidth,
      winH: window.innerHeight,

      promptMsg: ''

    }
  }
  initBindings() {

    this.handleCalibrationTimeout       = this.handleCalibrationTimeout.bind(this);
    this.handleConfigReady              = this.handleConfigReady.bind(this);
    this.handleControlChange            = this.handleControlChange.bind(this);
    this.handleFullScreenCheckboxChange = this.handleFullScreenCheckboxChange.bind(this);
    this.handleKeyDown                  = this.handleKeyDown.bind(this);
    this.handleLeapFrame                = this.handleLeapFrame.bind(this);
    this.handleLeapZoneUpdate           = this.handleLeapZoneUpdate.bind(this);
    this.handleRecalibrateClick         = this.handleRecalibrateClick.bind(this);
    this.handleWindowResize             = this.handleWindowResize.bind(this);

  }
  initDocsFolder() {

    const userDocs = electronApp.getPath('documents').split('\\').join('/'),
          appName  = electronApp.getName(),
          path     = `${userDocs}/${appName}/`;

    mkdirp.sync(path);

    App.docsPath = path;
    App.fileExists = (filePath) => {
      return electronFs.existsSync(App.docsPath + filePath)
    }
    App.pathTo = (filePath) => {
      return App.docsPath + filePath;
    }
    App.writeFile = (filePath, data, onSuccess) => {
      const path = App.docsPath + filePath;
      electronFs.writeFile(path, data, { encoding: 'utf-8' }, (error) => {
        if (error) {
          console.log(`Problem writing file ${path}: ${error.message}`);
          return;
        }
        if (onSuccess) {
          onSuccess();
        }
      });
    }
    App.loadFile = (filePath, onSuccess, onError = console.log, errorMsg = '') => {
      const path = App.docsPath + filePath;
      electronFs.readFile(path, { encoding: 'utf-8' }, (error, data) => {
        if (error) {
          onError(error.message, errorMsg)
          return;
        }
        onSuccess(data);
      });
    }

  }
  initFullscreen() {

    if (screenfull.enabled) {
      screenfull.on('change', () => {
        this.forceUpdate();
      });
    }

  }
  initHeatmap() {

    this.history = [];
    this.heatmap = [];

  }

  initConfig() {

    net.xhrFetch(FILENAME_CONFIG_DEFAULT)
      .then((data) => data.text())
      .then((data) => {
        App.writeFile(FILENAME_CONFIG_DEFAULT, data);
        if (!App.fileExists(FILENAME_CONFIG)) {
          App.writeFile(FILENAME_CONFIG, data, this.handleConfigReady);
        } else {
          App.loadFile(FILENAME_CONFIG, this.handleConfigReady);
        }
      })
      .catch((error) => {
        console.log(`Problem loading default 'Config' file.`);
        console.log(error);
      });

  }

  // Getters & setters

  get handsOn() {
    return (this.state.hands !== undefined) && (this.state.hands.length > 0);
  }


  // Event handlers

  handleConfigReady(data) {

    App.config = JSON.parse(data);

    this.initLeap();

    this.setState({
      ready: true
    });

  }

  handleKeyDown(e) {

    switch (e.key) {

      case 'f':
        e.preventDefault();
        this.setState({
          fullscreen: !this.state.fullscreen
        });
        break;

      case 'h':
        e.preventDefault();
        this.setState({
          showHeatmap: !this.state.showHeatmap
        });
        break;

      case 'l':
        e.preventDefault();
        this.setState({
          showLeapZone: !this.state.showLeapZone
        });
        break;

    }

  }

  handleWindowResize(e) {

    this.setState({
      winW: window.innerWidth,
      winH: window.innerHeight
    });

  }

  handleLeapFrame(e) {

    this.setState({
      hands: e.hands
    });

    if (this.state.isCalibrating) {
      this.updateCalibration();
    }

    if (this.handsOn) {
      this.updateHeatmap();
    }

  }
  handleLeapZoneUpdate(e) {

    this.setState({
      leapMinX: Math.round(this.leap.xMin),
      leapMinY: Math.round(this.leap.yMin),
      leapMaxX: Math.round(this.leap.xMax),
      leapMaxY: Math.round(this.leap.yMax)
    });

  }

  handleControlChange(e) {

    const val   = (e.target.type === 'checkbox') ? e.target.checked : Number(e.target.value),
          name  = e.target.name;

    this.setState({
      [name]: val
    });

  }
  handleFullScreenCheckboxChange(e) {

    if (!screenfull.enabled) return;

    this.setState({
      fullscreen: e.target.checked
    });

  }

  handleRecalibrateClick(e) {

    this.restartCalibration();

  }

  handleCalibrationTimeout() {

    this.saveCalibrationPt();

    if (this.state.calibrationStep < CALIBRATION_STEPS - 1) {
      this.advanceCalibration();
    } else {
      this.completeCalibration();
    }

  }


  // Methods


  initLeap() {

    const config = App.config.leap,
          calib  = config.defaultCalibration;

    this.leap    = new LeapAgent({
      enable: true,
      host: config.host,
      port: config.port,
      xMin: calib.xMin,
      xMax: calib.xMax,
      yMin: calib.yMin,
      yMax: calib.yMax,
      zMin: calib.zMin,
      zMax: calib.zMax
    });

    this.leap.addListener('leapFrame', this.handleLeapFrame.bind(this));
    this.leap.addListener('zoneUpdate', this.handleLeapZoneUpdate.bind(this));

  }


  requestFullscreen(el) {
    return el.requestFullscreen || el.msRequestFullscreen || el.mozRequestFullScreen || el.webkitRequestFullscreen;
  }

  getAppAreaRect() {

    const spanLeapX = new Span(this.state.leapMinX, this.state.leapMaxX),
          spanLeapY = new Span(this.state.leapMinY, this.state.leapMaxY),
          winSpanX  = new Span(0, this.state.winW),
          winSpanY  = new Span(0, this.state.winH);

    const x = spanLeapX.mapToSpan(this.state.appMinX, winSpanX),
          y = spanLeapY.mapToSpan(this.state.appMinY, winSpanY),
          r = spanLeapX.mapToSpan(this.state.appMaxX, winSpanX),
          b = spanLeapY.mapToSpan(this.state.appMaxY, winSpanY),
          w = r - x,
          h = b - y;

    return new Rect(x, y, w, h).absolutized();

  }
  getHandsViewData() {

    const rectLeap = new Rect(
      this.state.leapMinX,
      this.state.leapMinY,
      this.state.leapMaxX - this.state.leapMinX,
      this.state.leapMaxY - this.state.leapMinY
    );

    const rectApp  = new Rect(
      this.state.appMinX,
      this.state.appMinY,
      this.state.appMaxX - this.state.appMinX,
      this.state.appMaxY - this.state.appMinY
    );

    const normRect    = this.state.showLeapZone ? rectLeap : rectApp;

    const rectWin  = new Rect(
      0,
      0,
      this.state.winW,
      this.state.winH
    );

    let hands = [];

    this.state.hands.forEach((hand, i) => {

      let hue   = maths.lerp(0, 120, hand.confidence),
          hx    = rectWin.lerpX(normRect.normX(hand.x)),
          hy    = rectWin.lerpY(normRect.normY(hand.y));

      let anyBadVals  = isNaN(hue) || isNaN(hx) || isNaN(hy);

      if (!anyBadVals) {
        hands.push({
          backgroundColor: `hsl(${hue}, 100%, 50%)`,
          left: Math.round(hx) + 'px',
          top: Math.round(hy) + 'px'
        });
      }

    })

    return hands;

  }

  getPrompt() {

    if (this.state.isCalibrating) {

        if (this.state.calibrationReady) {
          return `Point at location #${(this.state.calibrationStep + 1)}`;
        } else {
          return 'Move hand away from sensor'
        }

    }

  }

  restartCalibration() {

    this.setState({
      showLeapZone: false,
      isCalibrating: true,
      calibrationStep: 0,
      calibrationPts: [],
      calibrationReady: !this.handsOn,
      calibrationRegistering: false
    })

    this.savedPts = [];

    this.updateCalibration();

  }
  resetCalibrationStep() {

    if (this.timeoutCalibration !== undefined) {
      clearTimeout(this.timeoutCalibration);
      this.timeoutCalibration  = undefined;
    }

    this.stepPts  = [];

  }
  updateCalibration() {

    const hands = this.state.hands;

    if (!this.state.calibrationReady) {

      if (!hands.length) {
        this.resetCalibrationStep();
        this.setState({
          calibrationReady: true
        });
      }

    } else {

      if (hands.length > 1) {
        this.setState({
          calibrationReady: false,
          calibrationRegistering: false
        });

      } else if (hands[0]) {

        this.setState({
          calibrationRegistering: true
        })

        if (this.timeoutCalibration === undefined) {
          this.timeoutCalibration = setTimeout(
            this.handleCalibrationTimeout.bind(this),
            App.config.calibration.holdDuration * 1000
          );
        }

        this.stepPts.push({
          x: hands[0].x,
          y: hands[0].y
        });

        this.checkStepPts();

      } else {
        this.setState({
          calibrationRegistering: false
        });
        this.resetCalibrationStep();

      }

    }

  }
  checkStepPts() {

    let minX, maxX, minY, maxY;

    this.stepPts.forEach((pt, i) => {
      if (minX === undefined || pt.x < minX) minX = pt.x;
      if (maxX === undefined || pt.x > maxX) maxX = pt.x;
      if (minY === undefined || pt.y < minY) minY = pt.y;
      if (maxY === undefined || pt.y > maxY) maxY = pt.y;
    });

    let distX = maxX - minX,
        distY = maxY - minY;

    if (distX > App.config.calibration.maxMoveDist || distY > App.config.calibration.maxMoveDist) {
      this.resetCalibrationStep();
    }

  }
  advanceCalibration() {

    this.resetCalibrationStep();
    this.setState({
      calibrationStep: this.state.calibrationStep + 1,
      calibrationReady: false,
      calibrationRegistering: false
    });

  }
  completeCalibration() {

    let avgL  = maths.lerp(this.savedPts[0].x, this.savedPts[2].x, 0.5),
        avgR  = maths.lerp(this.savedPts[1].x, this.savedPts[3].x, 0.5),
        avgT  = maths.lerp(this.savedPts[0].y, this.savedPts[1].y, 0.5),
        avgB  = maths.lerp(this.savedPts[2].y, this.savedPts[3].y, 0.5);

    const padW  = (this.state.winW * App.config.calibration.padPerc),
          padH  = (this.state.winH * App.config.calibration.padPerc);

    let areaW = (avgR - avgL) / (1 - (2 * App.config.calibration.padPerc)),
        areaH = (avgB - avgT) / (1 - (2 * App.config.calibration.padPerc)),
        minX  = avgL - (areaW * App.config.calibration.padPerc),
        minY  = avgT - (areaH * App.config.calibration.padPerc),
        maxX  = minX + areaW,
        maxY  = minY + areaH;

    this.setState({
      appMinX: maths.roundTo(minX, 1),
      appMinY: maths.roundTo(minY, 1),
      appMaxX: maths.roundTo(maxX, 1),
      appMaxY: maths.roundTo(maxY, 1),
      calibrationStep: CALIBRATION_STEPS,
      isCalibrating: false,
      showLeapZone: false
    });

  }
  saveCalibrationPt() {

    const count = this.stepPts.length,
          index = this.state.calibrationStep,
          sumX  = this.stepPts.reduce((sum, cur) => (sum + cur.x), 0),
          sumY  = this.stepPts.reduce((sum, cur) => (sum + cur.y), 0);

    this.savedPts[index] = {
      x: sumX / count,
      y: sumY / count
    };

  }

  updateHeatmap() {

    const MAX_HISTORY = 10000;

    const rectLeap    = new Rect(
      this.state.leapMinX,
      this.state.leapMinY,
      this.state.leapMaxX - this.state.leapMinX,
      this.state.leapMaxY - this.state.leapMinY
    );
    const rectApp     = new Rect(
      this.state.appMinX,
      this.state.appMinY,
      this.state.appMaxX - this.state.appMinX,
      this.state.appMaxY - this.state.appMinY
    );
    const normRect    = this.state.showLeapZone ? rectLeap : rectApp;

    this.heatmap      = [];
    this.history      = this.history.concat(this.state.hands);

    if (this.history.length > MAX_HISTORY) {
      this.history    = this.history.slice(-MAX_HISTORY);
    }

    this.history.forEach((hand) => {

      let col   = Math.floor(normRect.normX(hand.x) * App.config.view.heatmap.cols),
          row   = Math.floor(normRect.normY(hand.y) * App.config.view.heatmap.rows),
          index = (row * App.config.view.heatmap.cols) + col;

      if (!this.heatmap[index]) {
        this.heatmap[index] = [ hand.confidence ];
      } else {
        this.heatmap[index].push(hand.confidence);
      }

    });

    this.heatmap.forEach((history, i) => {
      this.heatmap[i] = this.heatmap[i].reduce((sum, cur) => ( sum + cur ), 0) / (this.heatmap[i].length || 1);
    });

  }


  // React lifecycle

  render() {

    const hasCalibration = this.state.appMinX !== undefined &&
                           this.state.appMinY !== undefined &&
                           this.state.appMaxX !== undefined &&
                           this.state.appMaxY !== undefined;

    const rectApp        = hasCalibration ? this.getAppAreaRect() : undefined,
          hands          = this.getHandsViewData();

    const promptMsg      = this.getPrompt();

    const appClasses     = classNames({
      "app": true,
      "hands-on": this.handsOn
    })

    return (

      <div className={appClasses}>

        {(this.state.showHeatmap && !this.state.isCalibrating) && (
          <Heatmap
            colCount={App.config.view.heatmap.cols}
            rowCount={App.config.view.heatmap.rows}
            data={this.heatmap} />
        )}

        {(this.state.showLeapZone && hasCalibration) && (
          <div
            className='app-zone'
            style={{
              left:   rectApp.x + 'px',
              top:    rectApp.y + 'px',
              width:  rectApp.w + 'px',
              height: rectApp.h + 'px'
            }}>
            <p>App window area</p>
          </div>
        )}

        {(hands.length > 0) && (
          <HandsDisplay
            hands={hands} />
        )}

        {promptMsg && (
          <div className='prompt'>
              <p>{promptMsg}</p>
          </div>
        )}

        {!this.state.isCalibrating && (
          <ControlsPanel
            fullscreen={this.state.fullscreen}
            showHeatmap={this.state.showHeatmap}
            showLeapZone={this.state.showLeapZone}
            appMinX={this.state.appMinX}
            appMinY={this.state.appMinY}
            appMaxX={this.state.appMaxX}
            appMaxY={this.state.appMaxY}
            leapMinX={this.state.leapMinX}
            leapMinY={this.state.leapMinY}
            leapMaxX={this.state.leapMaxX}
            leapMaxY={this.state.leapMaxY}
            onControlChange={this.handleControlChange}
            onFullScreenCheckboxChange={this.handleFullScreenCheckboxChange}
            onRecalibrateClick={this.handleRecalibrateClick} />
        )}

        {this.state.isCalibrating && (
          <Calibration
            padPerc={App.config.calibration.padPerc}
            step={this.state.calibrationStep}
            ready={this.state.calibrationReady}
            registering={this.state.calibrationRegistering}
            winW={this.state.winW}
            winH={this.state.winH} />
        )}

        <div className='frame' />

      </div>

    );

  }

  componentDidUpdate() {

    if (this.state.fullscreen) {
      if (!screenfull.isFullscreen) {
        screenfull.request(document.body);
      }
    } else {
      if (screenfull.isFullscreen) {
        screenfull.exit();
      }
    }

  }
  componentDidMount() {

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('resize', this.handleWindowResize);

  }
  componentWillUnmount() {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('resize', this.handleWindowResize);
  }

}
