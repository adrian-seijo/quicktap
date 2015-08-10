'use strict';

module.exports = {
	/**
	 * Windows Phone 8.1 fakes user agent string to look like Android and iPhone.
	 * @type boolean
	 */
	WINDOWS_PHONE: navigator.userAgent.indexOf('Windows Phone') >= 0,

	/**
	 * Android requires exceptions.
	 * @type boolean
	 */
	ANDROID: navigator.userAgent.indexOf('Android') > 0 && navigator.userAgent.indexOf('Windows Phone') < 0,

	/**
	 * iOS requires exceptions.
	 * @type boolean
	 */
	IOS: /iP(ad|hone|od)/.test(navigator.userAgent) && navigator.userAgent.indexOf('Windows Phone') < 0,
};
