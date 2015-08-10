
'use strict';

var device = require('./device');

// at some point reenable
// "indent": [2, 4, {"SwitchCase": 1}],
// in the .eslintrc file

/**
 * @preserve QuickTap: polyfill to remove click delays on browsers with touch UIs.
 * @codingstandard ftlabs-jsv2
 * @copyright The Financial Times Limited [All Rights Reserved]
 * @license MIT License (see LICENSE.txt)
 */

/**
 * Windows Phone 8.1 fakes user agent string to look like Android and iPhone.
 * @type boolean
 */
var DEVICE_IS_WINDOWS_PHONE = navigator.userAgent.indexOf('Windows Phone') >= 0;

/**
 * Android requires exceptions.
 * @type boolean
 */
var DEVICE_IS_ANDROID = navigator.userAgent.indexOf('Android') > 0 && !DEVICE_IS_WINDOWS_PHONE;

/**
 * iOS requires exceptions.
 * @type boolean
 */
var DEVICE_IS_IOS = /iP(ad|hone|od)/.test(navigator.userAgent) && !DEVICE_IS_WINDOWS_PHONE;

/**
 * iOS 4 requires an exception for select elements.
 * @type boolean
 */
var DEVICE_IS_IOS4 = DEVICE_IS_IOS && (/OS 4_\d(_\d)?/).test(navigator.userAgent);

/**
 * iOS 6.0-7.* requires the target element to be manually derived
 * @type boolean
 */
var DEVICE_IS_IOS_WITH_BAD_TARGET = DEVICE_IS_IOS && (/OS [6-7]_\d/).test(navigator.userAgent);

/**
 * BlackBerry requires exceptions.
 * @type boolean
 */
var DEVICE_IS_BLACKBERRY_10 = navigator.userAgent.indexOf('BB10') > 0;

/**
 * Instantiate fast-clicking listeners on the specified layer.
 *
 * @constructor
 * @param {Element} layer The layer to listen on
 * @param {Object} The options to override the defaults
 */
function QuickTap(layer, opts) {

	var options = opts || {};

	// If we dont need to handle this just ignore
	if (QuickTap.notNeeded(layer)) return;

	/**
	 * Whether a click is currently being tracked.
	 * @type {Boolean}
	 */
	this.trackingClick = false;

	/**
	 * Timestamp for when click tracking started.
	 * @type {Number}
	 */
	this.trackingClickStart = 0;

	/**
	 * The element being tracked for a click.
	 * @type {Element}
	 */
	this.targetElement = null;

	/**
	 * X-coordinate of touch start event.
	 * @type {Number}
	 */
	this.touchStartX = 0;

	/**
	 * Y-coordinate of touch start event.
	 * @type {Number}
	 */
	this.touchStartY = 0;

	/**
	 * ID of the last touch, retrieved from Touch.identifier.
	 * @type {Number}
	 */
	this.lastTouchIdentifier = 0;

	/**
	 * Touchmove boundary, beyond which a click will be cancelled.
	 * @type {Number}
	 */
	this.touchBoundary = options.touchBoundary || 10;

	/**
	 * The QuickTap layer.
	 * @type {Element}
	 */
	this.layer = layer;

	/**
	 * The minimum time between tap(touchstart and touchend) events
	 * @type {Number}
	 */
	this.tapDelay = options.tapDelay || 200;

	/**
	 * The maximum time for a tap
	 * @type {Number}
	 */
	this.tapTimeout = options.tapTimeout || 700;

	// Cache the binded the methods so then we can easily remove them later
	this.onMouse = this.onMouse.bind(this);
	this.onClick = this.onClick.bind(this);
	this.onTouchStart = this.onTouchStart.bind(this);
	this.onTouchMove = this.onTouchMove.bind(this);
	this.onTouchEnd = this.onTouchEnd.bind(this);
	this.onTouchCancel = this.onTouchCancel.bind(this);

	// For android listen to mouse events
	if (device.ANDROID) {
		layer.addEventListener('mouseover', this.onMouse, true);
		layer.addEventListener('mousedown', this.onMouse, true);
		layer.addEventListener('mouseup', this.onMouse, true);
	}

	layer.addEventListener('click', this.onClick, true);
	layer.addEventListener('touchstart', this.onTouchStart, false);
	layer.addEventListener('touchmove', this.onTouchMove, false);
	layer.addEventListener('touchend', this.onTouchEnd, false);
	layer.addEventListener('touchcancel', this.onTouchCancel, false);

	// If a handler is already declared in the element's onclick attribute, it will be fired before
	// QuickTap's onClick handler. Fix this by pulling out the user-defined handler function and
	// adding it as listener.
	if (typeof layer.onclick === 'function') {

		// Android browser on at least 3.2 requires a new reference to the function in layer.onclick
		// - the old one won't work if passed to addEventListener directly.
		var oldOnClick = layer.onclick;
		layer.addEventListener('click', function(event) {
			oldOnClick(event);
		}, false);
		layer.onclick = null;
	}
}

/**
 * Determine whether a given element requires a native click.
 *
 * @param {EventTarget|Element} target Target DOM element
 * @returns {boolean} Returns true if the element needs a native click
 */
QuickTap.prototype.needsClick = function(target) {

	switch (target.nodeName.toLowerCase()) {

		// Don't send a synthetic click to disabled inputs (issue #62)
		case 'button':
		case 'select':
		case 'textarea':
			if (target.disabled) return true;
			break;

		case 'input':
			// File inputs need real clicks on iOS 6 due to a browser bug (issue #68)
			if ((device.IOS && target.type === 'file') || target.disabled) return true;
			break;

		case 'label':
		case 'iframe': // iOS8 homescreen apps can prevent events bubbling into frames
		case 'video':
			return true;

		default:
			break;
	}

	return (/\bneedsclick\b/).test(target.className);
};

/**
 * Determine whether a given element requires a call to focus to simulate click into element.
 *
 * @param {EventTarget|Element} target Target DOM element
 * @returns {boolean} Returns true if the element requires a call to focus to simulate native click.
 */
QuickTap.prototype.needsFocus = function(target) {

	switch (target.nodeName.toLowerCase()) {
		case 'textarea':
			return true;

		case 'select':
			return !device.ANDROID;

		case 'input':
			switch (target.type) {
				case 'button':
				case 'checkbox':
				case 'file':
				case 'image':
				case 'radio':
				case 'submit':
					return false;
				default:
					break;
			}

			// No point in attempting to focus disabled inputs
			return !target.disabled && !target.readOnly;

		default:
			return (/\bneedsfocus\b/).test(target.className);
	}
};

/**
 * Send a click event to the specified element.
 * @param {EventTarget|Element} targetElement
 * @param {Event} event
 */
QuickTap.prototype.sendClick = function(targetElement, event) {
	var clickEvent, touch;

	// On some Android devices activeElement needs to be blurred otherwise the synthetic click will have no effect (#24)
	if (document.activeElement && document.activeElement !== targetElement) {
		document.activeElement.blur();
	}

	touch = event.changedTouches[0];

	// Synthesise a click event, with an extra attribute so it can be tracked
	clickEvent = document.createEvent('MouseEvents');
	clickEvent.initMouseEvent(
		this.determineEventType(targetElement),
		true,
		true,
		window,
		1,
		touch.screenX,
		touch.screenY,
		touch.clientX,
		touch.clientY,
		false,
		false,
		false,
		false,
		0,
		null
	);

	clickEvent.forwardedTouchEvent = true;
	targetElement.dispatchEvent(clickEvent);
};

QuickTap.prototype.determineEventType = function(targetElement) {

	// Issue #159: Android Chrome Select Box does not open with a synthetic click event
	if (device.ANDROID && targetElement.tagName.toLowerCase() === 'select') {
		return 'mousedown';
	}

	return 'click';
};

/**
 * @param {EventTarget|Element} targetElement
 */
QuickTap.prototype.focus = function(targetElement) {
	var length;

	// According to the whatwg spec only text, search, url, tel and password inputs have selection so its not a bug
	// its a poorly implemented spec that should fail even more.
	// https://html.spec.whatwg.org/multipage/forms.html#concept-input-apply
	if (device.IOS && targetElement.setSelectionRange && targetElement.type === 'text' ||
		targetElement.type === 'search' || targetElement.type === 'url' || targetElement.type === 'tel' ||
		targetElement.type === 'password') {

		length = targetElement.value.length;
		targetElement.setSelectionRange(length, length);

	} else {
		targetElement.focus();
	}
};

/**
 * Check whether the given target element is a child of a scrollable layer and if so, set a flag on it.
 * @param {EventTarget|Element} targetElement
 */
QuickTap.prototype.updateScrollParent = function(targetElement) {
	var scrollParent, parentElement;

	scrollParent = targetElement.fastClickScrollParent;

	// Attempt to discover whether the target element is contained within a scrollable layer. Re-check if the
	// target element was moved to another parent.
	if (!scrollParent || !scrollParent.contains(targetElement)) {
		parentElement = targetElement;
		do {
			if (parentElement.scrollHeight > parentElement.offsetHeight) {
				scrollParent = parentElement;
				targetElement.fastClickScrollParent = parentElement;
				break;
			}

			parentElement = parentElement.parentElement;
		} while (parentElement);
	}

	// Always update the scroll top tracker if possible.
	if (scrollParent) {
		scrollParent.fastClickLastScrollTop = scrollParent.scrollTop;
	}
};

/**
 * @param {EventTarget} targetElement
 * @returns {Element|EventTarget}
 */
QuickTap.prototype.getTargetElementFromEventTarget = function(eventTarget) {

	// On some older browsers (notably Safari on iOS 4.1 - see issue #56) the event target may be a text node.
	if (eventTarget.nodeType === Node.TEXT_NODE) {
		return eventTarget.parentNode;
	}

	return eventTarget;
};


/**
 * On touch start, record the position and scroll offset.
 *
 * @param {Event} event
 * @returns {boolean}
 */
QuickTap.prototype.onTouchStart = function(event) {
	var targetElement, touch, selection;

	// Ignore multiple touches, otherwise pinch-to-zoom is prevented if both fingers are on the QuickTap
	// element (issue #111).
	if (event.targetTouches.length > 1) {
		return true;
	}

	targetElement = this.getTargetElementFromEventTarget(event.target);
	touch = event.targetTouches[0];

	if (device.IOS) {

		// Only trusted events will deselect text on iOS (issue #49)
		selection = window.getSelection();
		if (selection.rangeCount && !selection.isCollapsed) {
			return true;
		}

		if (!DEVICE_IS_IOS4) {

			// Weird things happen on iOS when an alert or confirm dialog is opened from a click event callback (issue #23):
			// when the user next taps anywhere else on the page, new touchstart and touchend events are dispatched
			// with the same identifier as the touch event that previously triggered the click that triggered the alert.
			// Sadly, there is an issue on iOS 4 that causes some normal touch events to have the same identifier as an
			// immediately preceeding touch event (issue #52), so this fix is unavailable on that platform.
			// Issue 120: touch.identifier is 0 when Chrome dev tools 'Emulate touch events' is set with an iOS device UA string,
			// which causes all touch events to be ignored. As this block only applies to iOS, and iOS identifiers are always long,
			// random integers, it's safe to to continue if the identifier is 0 here.
			if (touch.identifier && touch.identifier === this.lastTouchIdentifier) {
				event.preventDefault();
				return false;
			}

			this.lastTouchIdentifier = touch.identifier;

			// If the target element is a child of a scrollable layer (using -webkit-overflow-scrolling: touch) and:
			// 1) the user does a fling scroll on the scrollable layer
			// 2) the user stops the fling scroll with another tap
			// then the event.target of the last 'touchend' event will be the element that was under the user's finger
			// when the fling scroll was started, causing QuickTap to send a click event to that layer - unless a check
			// is made to ensure that a parent layer was not scrolled before sending a synthetic click (issue #42).
			this.updateScrollParent(targetElement);
		}
	}

	this.trackingClick = true;
	this.trackingClickStart = event.timeStamp;
	this.targetElement = targetElement;

	this.touchStartX = touch.pageX;
	this.touchStartY = touch.pageY;

	// Prevent phantom clicks on fast double-tap (issue #36)
	if ((event.timeStamp - this.lastClickTime) < this.tapDelay) {
		event.preventDefault();
	}

	return true;
};


/**
 * Based on a touchmove event object, check whether the touch has moved past a boundary since it started.
 *
 * @param {Event} event
 * @returns {boolean}
 */
QuickTap.prototype.touchHasMoved = function(event) {
	var touch = event.changedTouches[0], boundary = this.touchBoundary;

	if (Math.abs(touch.pageX - this.touchStartX) > boundary || Math.abs(touch.pageY - this.touchStartY) > boundary) {
		return true;
	}

	return false;
};


/**
 * Update the last position.
 *
 * @param {Event} event
 * @returns {boolean}
 */
QuickTap.prototype.onTouchMove = function(event) {
	if (!this.trackingClick) {
		return true;
	}

	// If the touch has moved, cancel the click tracking
	if (this.targetElement !== this.getTargetElementFromEventTarget(event.target) || this.touchHasMoved(event)) {
		this.trackingClick = false;
		this.targetElement = null;
	}

	return true;
};


/**
 * Attempt to find the labelled control for the given label element.
 *
 * @param {EventTarget|HTMLLabelElement} labelElement
 * @returns {Element|null}
 */
QuickTap.prototype.findControl = function(labelElement) {

	// Fast path for newer browsers supporting the HTML5 control attribute
	if (labelElement.control !== undefined) {
		return labelElement.control;
	}

	// All browsers under test that support touch events also support the HTML5 htmlFor attribute
	if (labelElement.htmlFor) {
		return document.getElementById(labelElement.htmlFor);
	}

	// If no for attribute exists, attempt to retrieve the first labellable descendant element
	// the list of which is defined here: http://www.w3.org/TR/html5/forms.html#category-label
	return labelElement.querySelector('button, input:not([type=hidden]), keygen, meter, output, progress, select, textarea');
};


/**
 * On touch end, determine whether to send a click event at once.
 *
 * @param {Event} event
 * @returns {boolean}
 */
QuickTap.prototype.onTouchEnd = function(event) {
	var forElement, trackingClickStart, targetTagName, scrollParent, touch, targetElement = this.targetElement;

	if (!this.trackingClick) {
		return true;
	}

	// Prevent phantom clicks on fast double-tap (issue #36)
	if ((event.timeStamp - this.lastClickTime) < this.tapDelay) {
		this.cancelNextClick = true;
		return true;
	}

	if ((event.timeStamp - this.trackingClickStart) > this.tapTimeout) {
		return true;
	}

	// Reset to prevent wrong click cancel on input (issue #156).
	this.cancelNextClick = false;

	this.lastClickTime = event.timeStamp;

	trackingClickStart = this.trackingClickStart;
	this.trackingClick = false;
	this.trackingClickStart = 0;

	// On some iOS devices, the targetElement supplied with the event is invalid if the layer
	// is performing a transition or scroll, and has to be re-detected manually. Note that
	// for this to function correctly, it must be called *after* the event target is checked!
	// See issue #57; also filed as rdar://13048589 .
	if (DEVICE_IS_IOS_WITH_BAD_TARGET) {
		touch = event.changedTouches[0];

		// In certain cases arguments of elementFromPoint can be negative, so prevent setting targetElement to null
		targetElement = document.elementFromPoint(touch.pageX - window.pageXOffset, touch.pageY - window.pageYOffset) || targetElement;
		targetElement.fastClickScrollParent = this.targetElement.fastClickScrollParent;
	}

	targetTagName = targetElement.tagName.toLowerCase();
	if (targetTagName === 'label') {
		forElement = this.findControl(targetElement);
		if (forElement) {
			this.focus(targetElement);
			if (DEVICE_IS_ANDROID) {
				return false;
			}

			targetElement = forElement;
		}
	} else if (this.needsFocus(targetElement)) {

		// Case 1: If the touch started a while ago (best guess is 100ms based on tests for issue #36) then focus will be triggered anyway. Return early and unset the target element reference so that the subsequent click will be allowed through.
		// Case 2: Without this exception for input elements tapped when the document is contained in an iframe, then any inputted text won't be visible even though the value attribute is updated as the user types (issue #37).
		if ((event.timeStamp - trackingClickStart) > 100 || (DEVICE_IS_IOS && window.top !== window && targetTagName === 'input')) {
			this.targetElement = null;
			return false;
		}

		this.focus(targetElement);
		this.sendClick(targetElement, event);

		// Select elements need the event to go through on iOS 4, otherwise the selector menu won't open.
		// Also this breaks opening selects when VoiceOver is active on iOS6, iOS7 (and possibly others)
		if (!DEVICE_IS_IOS || targetTagName !== 'select') {
			this.targetElement = null;
			event.preventDefault();
		}

		return false;
	}

	if (DEVICE_IS_IOS && !DEVICE_IS_IOS4) {

		// Don't send a synthetic click event if the target element is contained within a parent layer that was scrolled
		// and this tap is being used to stop the scrolling (usually initiated by a fling - issue #42).
		scrollParent = targetElement.fastClickScrollParent;
		if (scrollParent && scrollParent.fastClickLastScrollTop !== scrollParent.scrollTop) {
			return true;
		}
	}

	// Prevent the actual click from going though - unless the target node is marked as requiring
	// real clicks or if it is in the whitelist in which case only non-programmatic clicks are permitted.
	if (!this.needsClick(targetElement)) {
		event.preventDefault();
		this.sendClick(targetElement, event);
	}

	return false;
};


/**
 * On touch cancel, stop tracking the click.
 *
 * @returns {void}
 */
QuickTap.prototype.onTouchCancel = function() {
	this.trackingClick = false;
	this.targetElement = null;
};

/**
 * Determine mouse events which should be permitted.
 *
 * @param {Event} event
 * @returns {boolean}
 */
QuickTap.prototype.onMouse = function(event) {

	// If a target element was never set (because a touch event was never fired) allow the event
	if (!this.targetElement) {
		return true;
	}

	if (event.forwardedTouchEvent) {
		return true;
	}

	// Programmatically generated events targeting a specific element should be permitted
	if (!event.cancelable) {
		return true;
	}

	// Derive and check the target element to see whether the mouse event needs to be permitted;
	// unless explicitly enabled, prevent non-touch click events from triggering actions,
	// to prevent ghost/doubleclicks.
	if (!this.needsClick(this.targetElement) || this.cancelNextClick) {

		// Prevent any user-added listeners declared on QuickTap element from being fired.
		if (event.stopImmediatePropagation) {
			event.stopImmediatePropagation();
		} else {

			// Part of the hack for browsers that don't support Event#stopImmediatePropagation (e.g. Android 2)
			event.propagationStopped = true;
		}

		// Cancel the event
		event.stopPropagation();
		event.preventDefault();

		return false;
	}

	// If the mouse event is permitted, return true for the action to go through.
	return true;
};


/**
 * On actual clicks, determine whether this is a touch-generated click, a click action occurring
 * naturally after a delay after a touch (which needs to be cancelled to avoid duplication), or
 * an actual click which should be permitted.
 *
 * @param {Event} event
 * @returns {boolean}
 */
QuickTap.prototype.onClick = function(event) {
	var permitted;

	// It's possible for another QuickTap-like library delivered with third-party code to fire a click event before QuickTap does (issue #44). In that case, set the click-tracking flag back to false and return early. This will cause onTouchEnd to return early.
	if (this.trackingClick) {
		this.targetElement = null;
		this.trackingClick = false;
		return true;
	}

	// Very odd behaviour on iOS (issue #18): if a submit element is present inside a form and the user hits enter in the iOS simulator or clicks the Go button on the pop-up OS keyboard the a kind of 'fake' click event will be triggered with the submit-type input element as the target.
	if (event.target.type === 'submit' && event.detail === 0) {
		return true;
	}

	permitted = this.onMouse(event);

	// Only unset targetElement if the click is not permitted. This will ensure that the check for !targetElement in onMouse fails and the browser's click doesn't go through.
	if (!permitted) {
		this.targetElement = null;
	}

	// If clicks are permitted, return true for the action to go through.
	return permitted;
};


/**
 * Remove all QuickTap's event listeners.
 *
 * @returns {void}
 */
QuickTap.prototype.destroy = function() {

	var layer = this.layer;

	if (device.ANDROID) {
		layer.removeEventListener('mouseover', this.onMouse, true);
		layer.removeEventListener('mousedown', this.onMouse, true);
		layer.removeEventListener('mouseup', this.onMouse, true);
	}

	layer.removeEventListener('click', this.onClick, true);
	layer.removeEventListener('touchstart', this.onTouchStart, false);
	layer.removeEventListener('touchmove', this.onTouchMove, false);
	layer.removeEventListener('touchend', this.onTouchEnd, false);
	layer.removeEventListener('touchcancel', this.onTouchCancel, false);
};

/**
 * Check whether QuickTap is needed.
 * @param {Element} layer The layer to listen on
 * @return {Boolean}
 */
QuickTap.notNeeded = function(layer) {

	var metaViewport;

	// Devices that don't support touch don't need QuickTap
	if (typeof window.ontouchstart === 'undefined') {
		return true;
	}

	if (device.WINDOWS_PHONE) {

		if (layer.style.msTouchAction === 'none' || layer.style.touchAction === 'none' ||
			layer.style.touchAction === 'manipulation' || layer.style.touchAction === 'manipulation') {

			return true;
		}

	} else if (device.IOS) {

		return false;

	} else {

		metaViewport = document.querySelector('meta[name=viewport]');

		if (!metaViewport) return false;
		if (metaViewport.content.indexOf('user-scalable=no') !== -1) return true;
		if (document.documentElement.scrollWidth <= window.outerWidth) return true;
	}

	return false;
};

/**
 * Factory method for creating a QuickTap object
 *
 * @param {Element} layer The layer to listen on
 * @param {Object} [options={}] The options to override the defaults
 */
QuickTap.attach = function(layer, options) {
	return new QuickTap(layer, options);
};

if (typeof define === 'function' && typeof define.amd === 'object' && define.amd) {

	define(function() { // AMD. Register as an anonymous module.
		return QuickTap;
	});

} else if (typeof module !== 'undefined' && module.exports) {

	module.exports = QuickTap.attach;
	module.exports.QuickTap = QuickTap;

} else {
	window.QuickTap = QuickTap;
}
