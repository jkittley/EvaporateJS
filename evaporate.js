/*Copyright (c) 2014, TT Labs, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

   Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

   Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

   Neither the name of the TT Labs, Inc. nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.*/


/***************************************************************************************************
*                                                                                                  *
*  version 0.0.2                                                                                  *
*                                                                                                  *
*  TODO:                                                                                           *
*       post eTags to application server to allow resumability after client-side crash/restart      *
*                                                                                                  *
*                                                                                                  *
***************************************************************************************************/

(function() {

  var Evaporate = function(config){

     this.supported = !((typeof(File)=='undefined') ||
        (typeof(Blob)=='undefined') ||
        !(!!Blob.prototype.webkitSlice || !!Blob.prototype.mozSlice || Blob.prototype.slice) ||
        config.testUnsupported);

     if(!this.supported){
        return;
     }


     var PENDING = 0, EVAPORATING = 2, COMPLETE = 3, PAUSED = 4, CANCELED = 5, ERROR = 10, ABORTED = 20, AWS_URL = config.aws_url || 'https://s3.amazonaws.com', ETAG_OF_0_LENGTH_BLOB = '"d41d8cd98f00b204e9800998ecf8427e"';

     var _ = this;
     var files = [];

     var con = extend({

        logging: true,
        maxConcurrentParts: 5,
        partSize: 6 * 1024 * 1024,
        retryBackoffPower: 2,
        maxRetryBackoffSecs: 300,
        progressIntervalMS: 500,
        cloudfront: false,
        encodeFilename: true,
        computeContentMd5: false

     }, config);
     if (con.computeContentMd5) {
        if (typeof con.cryptoMd5Method !== 'function') {
           alert('Option computeContentMd5 has been set but cryptoMd5Method is not defined.');
           return;
        }
     }

     //con.simulateStalling =  true

     _.add = function(file){

        l.d('add');
        var err;
        if (typeof file == 'undefined'){
           return 'Missing file';
        }
        if (typeof file.name == 'undefined'){
           err = 'Missing attribute: name  ';
        }
        else if(con.encodeFilename) {
           file.name = encodeURIComponent(file.name); // prevent signature fail in case file name has spaces 
        }       
        
        /*if (!(file.file instanceof File)){
           err += '.file attribute must be instanceof File';
        }*/
        if (err){return err;}

        var newId = addFile(file);
        asynProcessQueue();
        return newId;
     };

     _.cancel = function(id){

        l.d('cancel ', id);
        if (files[id]){
           files[id].stop();
           return true;
        } else {
           return false;
        }
     };

     _.pause = function(id){


     };

     _.resume = function(id){


     };

     _.forceRetry = function(){


     };

     var l = {d:function(){}, w: function(){}, e:function(){}};

     if(con.logging && console && console.log){
        l = console;
        l.d = l.log;

        if (console.warn){
           l.w = l.warn;
        }else{
           l.w = l.log;
        }

        if (console.error){
           l.e = l.error;
        }else{
           l.e = l.log;
        }
     }


     function addFile(file){

        var id = files.length;
        files.push(new FileUpload(extend({
           progress: function(){},
           complete: function(){},
           cancelled: function(){},
           info: function(){},
           warn: function(){},
           error: function(){}
        },file,{
           id: id,
           status: PENDING,
           priority: 0,
           onStatusChange: onFileUploadStatusChange,
           loadedBytes: 0,
           sizeBytes: file.file.size
        })));
        return id;
     }

     function onFileUploadStatusChange(){

        l.d('onFileUploadStatusChange');
        processQueue();

     }


     function asynProcessQueue(){

        setTimeout(processQueue,1);
     }


     function processQueue(){

        l.d('processQueue   length: ' + files.length);
        var next = -1, priorityOfNext = -1, readyForNext = true;
        files.forEach(function(file,i){

           if (file.priority > priorityOfNext && file.status == PENDING){
              next = i;
              priorityOfNext = file.priority;
           }

           if (file.status == EVAPORATING){
              readyForNext = false;
           }
        });

        if (readyForNext && next >= 0){
           files[next].start();
        }
     }


     function FileUpload(file){

        var me = this, parts = [], progressTotalInterval, progressPartsInterval, countUploadAttempts = 0, xhrs = [];
        extend(me,file);

        me.start = function(){

           l.d('starting FileUpload ' + me.id);

           setStatus(EVAPORATING);
           initiateUpload();
           monitorTotalProgress();
           monitorPartsProgress();
        };

        me.stop = function(){

           l.d('stopping FileUpload ', me.id);
           me.cancelled();
           setStatus(CANCELED);
           me.info('Canceling uploads...');
           cancelAllRequests();
        };


        function setStatus(s){
           if (s == COMPLETE || s == ERROR || s == CANCELED){
              clearInterval(progressTotalInterval);
              clearInterval(progressPartsInterval);
           }
           me.status = s;
           me.onStatusChange();
        }


        function cancelAllRequests(){
           l.d('cancelAllRequests()');

           xhrs.forEach(function(xhr,i){
              xhr.abort();
           });

           abortUpload();
        }


        function initiateUpload(){ // see: http://docs.amazonwebservices.com/AmazonS3/latest/API/mpUploadInitiate.html

           function processFileParts() {
              if (con.computeContentMd5 && me.file.size > 0) {
                 processPartsListWithMd5Digests();
              } else {
                 processPartsList();
              }
           }

           var initiate = {
              method: 'POST',
              path: getPath() + '?uploads',
              step: 'initiate',
              x_amz_headers: me.xAmzHeadersAtInitiate,
              not_signed_headers: me.notSignedHeadersAtInitiate
           };

           if (me.contentType){
              initiate.contentType = me.contentType;
           }

           initiate.onErr = function(xhr){
              l.d('onInitiateError for FileUpload ' + me.id);
              setStatus(ERROR);
           };

           initiate.on200 = function(xhr){

              var match = xhr.response.match(/<UploadId\>(.+)<\/UploadId\>/);
              if (match && match[1]){
                 me.uploadId = match[1];
                 l.d('requester success. got uploadId ' + me.uploadId);
                 makeParts();
                 processFileParts();
              }else{
                 initiate.onErr();
              }
           };

           setupRequest(initiate);
           authorizedSend(initiate);
        }


        function uploadPart(partNumber){  //http://docs.amazonwebservices.com/AmazonS3/latest/API/mpUploadUploadPart.html

           var backOff, hasErrored, upload, part;

           part = parts[partNumber];

           part.status = EVAPORATING;
           countUploadAttempts++;
           part.loadedBytesPrevious = null;

           backOff = part.attempts++ === 0 ? 0 : 1000 * Math.min(
              con.maxRetryBackoffSecs,
              Math.pow(con.retryBackoffPower,part.attempts-2)
           );
           l.d('uploadPart #' + partNumber + '     will wait ' + backOff + 'ms to try');

           function getAwsResponse(xhr) {
              var oParser = new DOMParser(),
                  oDOM = oParser.parseFromString(xhr.responseText, "text/xml"),
                  code = oDOM.getElementsByTagName("Code"),
                  msg = oDOM.getElementsByTagName("Message");
              code = code.length ? code[0].innerHTML : '';
              msg = msg.length ? msg[0].innerHTML : '';

              return code.length ? {code: code, msg: msg} : {};
           }

           upload = {
              method: 'PUT',
              path: getPath() + '?partNumber='+partNumber+'&uploadId='+me.uploadId,
              step: 'upload #' + partNumber,
              x_amz_headers: me.xAmzHeadersAtUpload,
              md5_digest: part.md5_digest,
              attempts: part.attempts
           };

           upload.onErr = function (xhr, isOnError){

              var msg = 'problem uploading part #' + partNumber + ',   http status: ' + xhr.status +
              ',   hasErrored: ' + !!hasErrored + ',   part status: ' + part.status +
              ',   readyState: ' + xhr.readyState + (isOnError ? ',   isOnError' : '');

              l.w(msg);
              me.warn(msg);

              if (hasErrored){
                 return;
              }
              hasErrored = true;

              if (xhr.status == 404){
                  var errMsg = '404 error resulted in abortion of both this part and the entire file.';
                  l.w(errMsg + ' Server response: ' + xhr.response);
                  me.error(errMsg);
                  part.status = ABORTED;
                  abortUpload();
              } else {
                 part.status = ERROR;
                 part.loadedBytes = 0;

                 awsResponse = getAwsResponse(xhr);
                 if (awsResponse.code) {
                    l.e('AWS Server response: code="' + awsResponse.code + '", message="' + awsResponse.msg + '"');
                 }
                 processPartsList();
              }
              xhr.abort();
           };

           upload.on200 = function (xhr){

              var eTag = xhr.getResponseHeader('ETag'), msg;
              l.d('uploadPart 200 response for part #' + partNumber + '     ETag: ' + eTag);
              if(part.isEmpty || (eTag != ETAG_OF_0_LENGTH_BLOB)) // issue #58
              { 
                 part.eTag = eTag;
                 part.status = COMPLETE;
              }
              else
              {
                 part.status = ERROR;
                 part.loadedBytes = 0;
                 msg = 'eTag matches MD5 of 0 length blob for part #' + partNumber  + '   Retrying part.';
                 l.w(msg);
                 me.warn(msg);
              }
              processPartsList();
           };

           upload.onProgress = function (evt){
              part.loadedBytes = evt.loaded;
           };

           upload.toSend = function() {
              var slice = getFilePart(me.file, part.start, part.end);
              l.d('part # ' + partNumber + ' (bytes ' + part.start + ' -> ' + part.end + ')  reported length: ' + slice.size);
              if(!part.isEmpty && slice.size === 0) // issue #58
              {
                 l.w('  *** WARN: blob reporting size of 0 bytes. Will try upload anyway..');
              }
              return slice;
           };

           upload.onFailedAuth = function(xhr){

              var msg = 'onFailedAuth for uploadPart #' + partNumber + '.   Will set status to ERROR';
              l.w(msg);
              me.warn(msg);
              part.status = ERROR;
              part.loadedBytes = 0;
              processPartsList();
           };

           setupRequest(upload);

           setTimeout(function(){
              authorizedSend(upload);
              l.d('upload #',partNumber,upload);
           },backOff);

           part.uploader = upload;
        }


        function abortPart(partNumber){

           var part = parts[partNumber];

           if (part.uploader.awsXhr){
              part.uploader.awsXhr.abort();
           }
           if (part.uploader.authXhr){
              part.uploader.authXhr.abort();
           }
        }


        function completeUpload(){ //http://docs.amazonwebservices.com/AmazonS3/latest/API/mpUploadComplete.html

           l.d('completeUpload');
           me.info('will attempt to complete upload');

           var completeDoc = '<CompleteMultipartUpload>';
           parts.forEach(function(part,partNumber){
              if (part){
                 completeDoc += '<Part><PartNumber>' + partNumber + '</PartNumber><ETag>' + part.eTag + '</ETag></Part>';
              }
           });
           completeDoc += '</CompleteMultipartUpload>';

           var complete = {
              method: 'POST',
              contentType: 'application/xml; charset=UTF-8',
              path: getPath() + '?uploadId='+me.uploadId,
              x_amz_headers: me.xAmzHeadersAtComplete,
              step: 'complete'
           };

           complete.onErr = function (){
              var msg = 'Error completing upload.';
              l.w(msg);
              me.error(msg);
              setStatus(ERROR);
           };

           complete.on200 = function(xhr){
              me.complete(xhr);
              setStatus(COMPLETE);
           };

           complete.toSend = function() {
              return completeDoc;
           };

           setupRequest(complete);
           authorizedSend(complete);
        }

        var numProcessed = 0,
            numParts = -1;

        function computePartMd5Digest(part) {
           return function () {
              var s = me.status;
              if (s == ERROR || s == CANCELED) {
                 return;
              }

              var md5_digest = con.cryptoMd5Method.call(this, this.result);

              l.d(['part #', part.part, ' MD5 digest is ', md5_digest].join(''));
              part.md5_digest = md5_digest;

              delete part.reader; // release potentially large memory allocation

              numProcessed += 1;

              processPartsList();

              if (numProcessed === numParts) {
                 l.d('All parts have MD5 digests');
              }

              setTimeout(processPartsListWithMd5Digests, 1500);
           }
        }

        function processPartsListWithMd5Digests() {
           // We need the request body to compute the MD5 checksum but the body is only available
           // as a FileReader object whose value is fetched asynchronously.

           // This method delays submitting the part for upload until its MD5 digest is ready
           for (var i = 1; i <= numParts; i++) {
              var part = parts[i];
              if (part.md5_digest === null) {
                 part.reader = new FileReader();
                 part.reader.onloadend = computePartMd5Digest(part);
                 part.reader.readAsBinaryString(getFilePart(me.file, part.start, part.end));
                 break;
              }
           }
        }

        function abortUpload() { //http://docs.amazonwebservices.com/AmazonS3/latest/API/mpUploadAbort.html

           l.d('abortUpload');
           me.info('will attempt to abort the upload');

           var abort = {
              method: 'DELETE',
              path: getPath() + '?uploadId=' + me.uploadId,
              step: 'abort',
              successStatus: 204
           };

           abort.onErr = function () {
              var msg = 'Error aborting upload.';
              l.w(msg);
              me.error(msg);
           };

           abort.on200 = function () {
              setStatus(ABORTED);
              checkForParts();
           };

           setupRequest(abort);
           authorizedSend(abort);
        }

        function checkForParts() { //http://docs.amazonwebservices.com/AmazonS3/latest/API/mpUploadListParts.html

           l.d('listParts');
           me.info('list parts');

           var list = {
              method: 'GET',
              path: getPath() + '?uploadId=' + me.uploadId,
              step: 'list'
           };

           list.onErr = function (xhr) {
              if (xhr.status == 404) {
                 // Success! Parts are not found because the uploadid has been cleared
                 me.info('upload canceled');
              } else {
                 var msg = 'Error listing parts.';
                 l.w(msg);
                 me.error(msg);
              }
           };

           list.on200 = function (xhr) {
              var oDOM = parseXml(xhr.responseText);
              var parts = oDOM.getElementsByTagName("Part");
              if (parts.length) { // Some parts are still uploading
                 l.d('Parts still found after abort...waiting.')
                 setTimeout(function () { abortUpload(); }, 1000);
              } else {
                 me.info('upload canceled');
              }
           };

           setupRequest(list);
           authorizedSend(list);
        }

        function makeParts(){

           numParts = Math.ceil(me.file.size / con.partSize) || 1; // issue #58
           for (var part = 1; part <= numParts; part++){

              parts[part] = {
                 status: PENDING,
                 start: (part-1)*con.partSize,
                 end: (part*con.partSize),
                 attempts: 0,
                 loadedBytes: 0,
                 loadedBytesPrevious: null,
                 md5_digest: null,
                 part: part,
                 isEmpty: (me.file.size === 0) // issue #58
              };
           }
        }


        function processPartsList(){

           var evaporatingCount = 0, finished = true, anyPartHasErrored = false, stati = [], bytesLoaded = [], info;

           if (me.status != EVAPORATING){
              me.info('will not process parts list, as not currently evaporating');
              return;
           }

           for (var i = 0; i < parts.length; i++) {
              var part = parts[i];
              if (part) {
                 if (con.computeContentMd5 && part.md5_digest === null) {
                    return; // MD5 Digest isn't ready yet
                 }
                 var requiresUpload = false;
                 stati.push(part.status);
                 switch(part.status){

                    case EVAPORATING:
                       finished = false;
                       evaporatingCount++;
                       bytesLoaded.push(part.loadedBytes);
                       break;

                    case ERROR:
                       anyPartHasErrored = true;
                       requiresUpload = true;
                       break;

                    case PENDING:
                       requiresUpload = true;
                       break;

                    default:
                       break;
                 }

                 if (requiresUpload){
                    finished = false;
                    if (evaporatingCount < con.maxConcurrentParts){
                       uploadPart(i);
                       evaporatingCount++;
                    }
                 }
              }
           }


           info = stati.toString() + ' // bytesLoaded: ' + bytesLoaded.toString();
           l.d('processPartsList()  anyPartHasErrored: ' + anyPartHasErrored,info);

           if (countUploadAttempts >= (parts.length-1) || anyPartHasErrored){
              me.info('part stati: ' + info);
           }
           // parts.length is always 1 greater than the actually number of parts, because AWS part numbers start at 1, not 0, so for a 3 part upload, the parts array is: [undefined, object, object, object], which has length 4.

           if (finished){
              completeUpload();
           }
        }


        function monitorTotalProgress(){

           progressTotalInterval = setInterval(function(){

              var totalBytesLoaded = 0;
              parts.forEach(function(part,i){
                 totalBytesLoaded += part.loadedBytes;
              });

              me.progress(totalBytesLoaded/me.sizeBytes);
           },con.progressIntervalMS);
        }


        /*
           Issue #6 identified that some parts would stall silently.
           The issue was only noted on Safari on OSX. A bug was filed with Apple, #16136393
           This function was added as a work-around. It checks the progress of each part every 2 minutes.
           If it finds a part that has made no progress in the last 2 minutes then it aborts it. It will then be detected as an error, and restarted in the same manner of any other errored part
        */
        function monitorPartsProgress(){

           progressPartsInterval = setInterval(function(){

              l.d('monitorPartsProgress() ' + Date());
              parts.forEach(function(part,i){

                 var healthy;

                 if (part.status != EVAPORATING){
                    l.d(i,  'not evaporating ');
                    return;
                 }

                 if (part.loadedBytesPrevious === null){
                    l.d(i,'no previous ');
                    part.loadedBytesPrevious = part.loadedBytes;
                    return;
                 }

                 healthy = part.loadedBytesPrevious < part.loadedBytes;
                 if (con.simulateStalling && i == 4){
                    if (Math.random() < 0.25){
                       healthy = false;
                    }
                 }

                 l.d(i, (healthy ? 'moving. ' : 'stalled.'), part.loadedBytesPrevious, part.loadedBytes);

                 if (!healthy){
                    setTimeout(function(){
                       me.info('part #' + i + ' stalled. will abort. ' + part.loadedBytesPrevious + ' ' + part.loadedBytes);
                       abortPart(i);
                    },0);
                 }

                 part.loadedBytesPrevious = part.loadedBytes;
              });
           },2 * 60 * 1000);
        }


        function setupRequest(requester){

           l.d('setupRequest()',requester);

           if(!con.timeUrl)
           {
               requester.dateString = new Date().toUTCString();
           }
           else
           {
               var xmlHttpRequest = new XMLHttpRequest(); 

               xmlHttpRequest.open("GET", con.timeUrl + '?requestTime=' + new Date().getTime(), false);
               xmlHttpRequest.send();
               requester.dateString = xmlHttpRequest.responseText;               
           }
           
           requester.x_amz_headers = extend(requester.x_amz_headers,{
              'x-amz-date': requester.dateString
           });

           requester.onGotAuth = function (){

              var xhr = new XMLHttpRequest();
              xhrs.push(xhr);
              requester.awsXhr = xhr;
              var payload = requester.toSend ? requester.toSend() : null;
              var url = AWS_URL + requester.path;
              var all_headers = {};
              var status_success = requester.successStatus || 200;
              extend(all_headers, requester.not_signed_headers);
              extend(all_headers, requester.x_amz_headers);

              if (con.simulateErrors && requester.attempts == 1 &&requester.step == 'upload #3'){
                 l.d('simulating error by POST part #3 to invalid url');
                 url = 'https:///foo';
              }

              xhr.open(requester.method, url);
              xhr.setRequestHeader('Authorization', 'AWS ' + con.aws_key + ':' + requester.auth);

              for (var key in all_headers) {
                 if (all_headers.hasOwnProperty(key)) {
                    xhr.setRequestHeader(key, all_headers[key]);
                 }
              }

              if (requester.contentType){
                 xhr.setRequestHeader('Content-Type', requester.contentType);
              }

              if (requester.md5_digest) {
                 xhr.setRequestHeader('Content-MD5', requester.md5_digest);
              }
              xhr.onreadystatechange = function(){

                 if (xhr.readyState == 4){

                    if(payload){l.d('  ### ' + payload.size);} // Test, per http://code.google.com/p/chromium/issues/detail?id=167111#c20
                    if (xhr.status == status_success) {
                       requester.on200(xhr);
                    } else {
                       requester.onErr(xhr);
                    }
                 }
              };

              xhr.onerror = function(){requester.onErr(xhr,true);};

              if (typeof requester.onProgress == 'function'){
                 xhr.upload.onprogress = function(evt){
                    requester.onProgress(evt);
                 };
              }
              xhr.send(payload);
           };

           requester.onFailedAuth = requester.onFailedAuth || function(xhr){
              me.error('Error onFailedAuth for step: ' + requester.step);
              requester.onErr(xhr);
           };
        }


        //see: http://docs.amazonwebservices.com/AmazonS3/latest/dev/RESTAuthentication.html#ConstructingTheAuthenticationHeader
        function authorizedSend(authRequester){

           l.d('authorizedSend() ' + authRequester.step);
           var xhr = new XMLHttpRequest();
           xhrs.push(xhr);
           authRequester.authXhr = xhr;
           var url = con.signerUrl+'?to_sign='+makeStringToSign(authRequester);
           var warnMsg;

           for (var param in me.signParams) {
              if (!me.signParams.hasOwnProperty(param)) {continue;}
             if( me.signParams[param] instanceof Function ) {
               url += ('&'+encodeURIComponent(param)+'='+encodeURIComponent(me.signParams[param]()));
             } else {
               url += ('&'+encodeURIComponent(param)+'='+encodeURIComponent(me.signParams[param]));
             }
           }

           xhr.onreadystatechange = function(){

              if (xhr.readyState == 4){

                 if (xhr.status == 200 && xhr.response.length == 28){

                    l.d('authorizedSend got signature for step: \'' + authRequester.step + '\'    sig: '+ xhr.response);
                    authRequester.auth = xhr.response;
                    authRequester.onGotAuth();

                 } else {
                    warnMsg = 'failed to get authorization (readyState=4) for ' + authRequester.step + '.  xhr.status: ' + xhr.status + '.  xhr.response: ' + xhr.response;
                    l.w(warnMsg);
                    me.warn(warnMsg);
                    authRequester.onFailedAuth(xhr);
                 }
              }
           };

           xhr.onerror = function(){
              warnMsg = 'failed to get authorization (onerror) for ' + authRequester.step + '.  xhr.status: ' + xhr.status + '.  xhr.response: ' + xhr.response;
              l.w(warnMsg);
              me.warn(warnMsg);
              authRequester.onFailedAuth(xhr);
           };

           xhr.open('GET', url);
           for ( var header in me.signHeaders ) {
             if (!me.signHeaders.hasOwnProperty(header)) {continue;}
             if( me.signHeaders[header] instanceof Function ) {
               xhr.setRequestHeader(header, me.signHeaders[header]())
             } else {
               xhr.setRequestHeader(header, me.signHeaders[header])
             }
           }
          
           if( me.beforeSigner instanceof Function ) {
             me.beforeSigner(xhr);
           }
           xhr.send();
        }

        function makeStringToSign(request){

           var x_amz_headers = '', to_sign, header_key_array = [];

           for (var key in request.x_amz_headers) {
              if (request.x_amz_headers.hasOwnProperty(key)) {
                 header_key_array.push(key);
              }
           }
           header_key_array.sort();

           header_key_array.forEach(function(header_key,i){
              x_amz_headers += (header_key + ':'+ request.x_amz_headers[header_key] + '\n');
           });


           to_sign = request.method+'\n'+
              (request.md5_digest || '')+'\n'+
              (request.contentType || '')+'\n'+
              '\n'+
              x_amz_headers +
              (con.cloudfront ? '/' + con.bucket : '')+
              request.path;
           return encodeURIComponent(to_sign);
        }

       function getPath() {
         var path = '/' + con.bucket + '/' + me.name;
         if (con.cloudfront || AWS_URL.indexOf('cloudfront') > -1) {
           path = '/' + me.name;
         }
         return path;
       }

     }


     function extend(obj1, obj2, obj3){

        if (typeof obj1 == 'undefined'){obj1 = {};}

        if (typeof obj3 == 'object'){
           for (var key in obj3){
              obj2[key]=obj3[key];
           }
        }

        for (var key2 in obj2){
           obj1[key2]=obj2[key2];
        }
        return obj1;
     }

     function parseXml(body) {
        var parser = new DOMParser();
        return parser.parseFromString(body, "text/xml");
     }

  };

   function getFilePart(file, start, end) {
      var slicerFn = (file.slice ? 'slice' : (file.mozSlice ? 'mozSlice' : 'webkitSlice'));
      // browsers' implementation of the Blob.slice function has been renamed a couple of times, and the meaning of the 2nd parameter changed. For example Gecko went from slice(start,length) -> mozSlice(start, end) -> slice(start, end). As of 12/12/12, it seems that the unified 'slice' is the best bet, hence it being first in the list. See https://developer.mozilla.org/en-US/docs/DOM/Blob for more info.
      return file[slicerFn](start, end);
   }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Evaporate;
  } else if (typeof window !== 'undefined') {
    window.Evaporate = Evaporate;
  }

})();
