
/*
 * JavaScript functions for interacting with micro:bit microcontrollers over WebUSB
 * (Only works in Chrome browsers;  Pages must be either HTTPS or local)
 */

// Add a delay() method to promises 
// NOTE: I found this on-line somewhere but didn't note the source and haven't been able to find it!
Promise.delay = function(duration){
    return new Promise(function(resolve, reject){
        setTimeout(function(){
            resolve();
        }, duration)
    });
}

const MICROBIT_VENDOR_ID = 0x0d28
const MICROBIT_PRODUCT_ID = 0x0204
//var MICROBIT_DAP_INTERFACE = 0     // Default interface

const controlTransferGetReport = 0x01
const controlTransferSetReport = 0x09
const controlTransferOutReport = 0x200
const controlTransferInReport = 0x100

const uBitBadMessageDelay = 500         // Delay if message failed
const uBitIncompleteMessageDelay = 150  // Delay if no message ready now
const uBitGoodMessageDelay = 20         // Time to try again if message was good



/*
   Open and configure a selected device and then start the read-loop
 */
function uBitOpenDevice(device, callback) {
    let buffer=""                               // Buffer of accumulated messages
    let decoder = new TextDecoder("utf-8")      // Decoder for byte->utf conversion
    const parser = /([^.:]*)\.*([^:]+|):(.*)/   // Parser to identify time-series format (graph:info or graph.series:info)
    let DAPOutReportRequest = {
        requestType: "class",
        recipient: "interface",
        request: controlTransferSetReport,
        value: controlTransferOutReport,
        index: 0
    }

    let DAPInReportRequest =  {
        requestType: "class",
        recipient: "interface",
        request: controlTransferGetReport,
        value: controlTransferInReport,
        index: 0
    }

    let transferLoop = () => {
        // 0x83 = ID_DAP_UART_Read : https://github.com/ARMmbed/DAPLink/blob/main/source/daplink/cmsis-dap/daplink_vendor_commands.h
        device.controlTransferOut(DAPOutReportRequest, Uint8Array.from([0x83])) // DAP ID_DAP_Vendor3: https://github.com/ARMmbed/DAPLink/blob/0711f11391de54b13dc8a628c80617ca5d25f070/source/daplink/cmsis-dap/DAP_vendor.c
          .then(() => device.controlTransferIn(DAPInReportRequest, 64))
          .then((data) => { 
            console.log("Data in")
            console.dir(data)
            if (data.status != "ok") {
                return Promise.delay(uBitBadMessageDelay).then(transferLoop);
            }
            // First byte is echo of get UART command: Ignore it

            let arr = new Uint8Array(data.data.buffer)
            if(arr.length<2)  // Not a valid array: Delay
                return Promise.delay(uBitIncompleteMessageDelay).then(transferLoop)

            // Data: Process and get more
            let len = arr[1]  // Second byte is length of remaining message
            if(len==0) // If no data: Delay
                return Promise.delay(uBitIncompleteMessageDelay).then(transferLoop)
            
            let msg = arr.slice(2,2+len)  // Get the actual UART bytes
            let string =  decoder.decode(msg);
            buffer += string;
            let firstNewline = buffer.indexOf("\n")
            while(firstNewline>=0) {
                let messageToNewline = buffer.slice(0,firstNewline)
                let now = new Date() 
                // Deal with line
                // If it's a graph/series format, break it into parts
                let parseResult = parser.exec(messageToNewline)
                if(parseResult) {
                    let graph = parseResult[1]
                    let series = parseResult[2]
                    let data = parseResult[3]
                    let callbackType = "graph-event"
                    // If data is numeric, it's a data message and should be sent as numbers
                    if(!isNaN(data)) {
                        callbackType = "graph-data"
                        data = parseFloat(data)
                    }
                    // Build and send the bundle
                    let dataBundle = {
                        time: now,
                        graph: graph, 
                        series: series, 
                        data: data
                    }
                    callback(callbackType, device, dataBundle)
                } else {
                    // Not a graph format.  Send it as a console bundle
                    let dataBundle = {time: now, data: messageToNewline}
                    callback("console", device, dataBundle)
                }

                buffer = buffer.slice(firstNewline+1)  // Advance to after newline
                firstNewline = buffer.indexOf("\n")    // See if there's more data
            }
            // Delay long enough for complete message
            return Promise.delay(uBitGoodMessageDelay).then(transferLoop);
        })
        // Error here probably means micro:bit disconnected
        .catch(error => { if(device.opened) callback("error", device, error); device.close();  callback("disconnected", device, null);});
    }

    let controlTransferOutFN = (data) => {
        return device.controlTransferOut(DAPOutReportRequest, data) 
    }

    let claimInterface = () => {
        index = 5
        DAPOutReportRequest.index = index
        DAPInReportRequest.index = index
        return device.claimInterface(index)        
/*

                          // Find interface; Based on https://github.com/microsoft/pxt/blob/58f4c4ae689c5a62be285d211c0d20cc7efba1d9/pxtlib/webusb.ts#L424
                          for(i of device.configurations[0].interfaces) {
                            console.dir(i)
                            a0 = i.alternates[0]
        
                            if(a0.interfaceClass == 255 && a0.interfaceSubclass==3 && a0.interfaceProtocol==0) 
                            {
                                console.log("Most match")
                                if( (a0.endpoints.length == 0) ||
                                    (a0.endpoints.length == 2 && a0.endpoints.every(e => e.packetSize == 64))) {
                                    console.log('Found interface')
                                    console.log(i.interfaceNumber)
                                    return device.claimInterface(i.interfaceNumber)
                                }
                            }
                        }
                        console.log("No Match")
                        // No match
                        return Promise.reject()
                    }

*/


    }
// https://github.com/microsoft/pxt-microbit/blob/347f1e11e66fb3001f644435b83592c76e133d6f/editor/flash.ts
    device.open()
          .then(() => device.selectConfiguration(1))
          .then(() => claimInterface(device))

          .then(() => controlTransferOutFN(Uint8Array.from([2, 0])))  // Connect in default mode: https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__Connect.html
          .then(() => controlTransferOutFN(Uint8Array.from([0x11, 0x80, 0x96, 0x98, 0]))) // Set Clock: 0x989680 = 10MHz : https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWJ__Clock.html
          .then(() => controlTransferOutFN(Uint8Array.from([0x13, 0]))) // SWD Configure (1 clock turn around; no wait/fault): https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWD__Configure.html
         // 0x82 = ID_DAP_UART_SetConfiguration : https://github.com/ARMmbed/DAPLink/blob/main/source/daplink/cmsis-dap/daplink_vendor_commands.h
          .then(() => controlTransferOutFN(Uint8Array.from([0x82, 0x00, 0xc2, 0x01, 0x00]))) // Vendor Specific command 2 (ID_DAP_Vendor2): https://github.com/ARMmbed/DAPLink/blob/0711f11391de54b13dc8a628c80617ca5d25f070/source/daplink/cmsis-dap/DAP_vendor.c ;  0x0001c200 = 115,200kBps



        //   .then(() => controlTransferOutFN(Uint8Array.from([17, 128, 150, 152, 0])))  // DAP_SWJ_Sequence
        //   .then(() => controlTransferOutFN(Uint8Array.from([2, 0])))  // Connect in default mode: https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__Connect.html
        //   .then(() => controlTransferOutFN(Uint8Array.from([4, 0, 100, 0, 0, 0])))  // Transfer Configure: https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__TransferConfigure.html;  0 extra idle ; 100 retries after wait
        //   .then(() => controlTransferOutFN(Uint8Array.from([18,  56, 255, 255, 255, 255, 255, 255, 255]))) // SWD Configure (1 clock turn around; no wait/fault): https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWD__Configure.html
        //   .then(() => controlTransferOutFN(Uint8Array.from([18,  16, 158, 231]))) // SWD Configure (1 clock turn around; no wait/fault): https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWD__Configure.html
        //   .then(() => controlTransferOutFN(Uint8Array.from([18,  8, 0]))) // SWD Configure (1 clock turn around; no wait/fault): https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWD__Configure.html
        //   .then(() => controlTransferOutFN(Uint8Array.from([129, ]))) //Vendor 1 or 3
        //   .then(() => controlTransferOutFN(Uint8Array.from([0x3]))) // DAP Disconnect???

        // ORIGINAL
        //   .then(() => controlTransferOutFN(Uint8Array.from([2, 0])))  // Connect in default mode: https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__Connect.html
        //   .then(() => controlTransferOutFN(Uint8Array.from([0x11, 0x80, 0x96, 0x98, 0]))) // Set Clock: 0x989680 = 10MHz : https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWJ__Clock.html
        //   .then(() => controlTransferOutFN(Uint8Array.from([0x13, 0]))) // SWD Configure (1 clock turn around; no wait/fault): https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWD__Configure.html
        //  // 0x82 = ID_DAP_UART_SetConfiguration : https://github.com/ARMmbed/DAPLink/blob/main/source/daplink/cmsis-dap/daplink_vendor_commands.h
        //   .then(() => controlTransferOutFN(Uint8Array.from([0x82, 0x00, 0xc2, 0x01, 0x00]))) // Vendor Specific command 2 (ID_DAP_Vendor2): https://github.com/ARMmbed/DAPLink/blob/0711f11391de54b13dc8a628c80617ca5d25f070/source/daplink/cmsis-dap/DAP_vendor.c ;  0x0001c200 = 115,200kBps
          .then(() => { callback("connected", device, null); console.log("Done with connected"); return Promise.resolve()}) 
          .then(() => transferLoop())
          .catch(error => { 
            console.log(error)
            callback("error", device, error)
        })
}

/**
 * Disconnect from a device 
 * @param {USBDevice} device to disconnect from 
 */
function uBitDisconnect(device) {
    if(device && device.opened) {
        device.close()
    }
}

/**
 * Send a string to a specific device
 * @param {USBDevice} device 
 * @param {string} data to send (must not include newlines)
 */
function uBitSend(device, data) {
    if(!device.opened)
        return
    // Need to send 0x84 (command), length (including newline), data's characters, newline
    let fullLine = data+'\n'
    let encoded = new TextEncoder("utf-8").encode(fullLine)
    let message = new Uint8Array(1+1+fullLine.length)
    message[0] = 0x84
    message[1] = encoded.length
    message.set(encoded, 2)
    device.controlTransferOut(DAPOutReportRequest, message) // DAP ID_DAP_Vendor3: https://github.com/ARMmbed/DAPLink/blob/0711f11391de54b13dc8a628c80617ca5d25f070/source/daplink/cmsis-dap/DAP_vendor.c
}


/**
 * Callback for micro:bit events
 * 
 
   Event data varies based on the event string:
  <ul>
   <li>"connection failure": null</li>
   <li>"connected": null</li>
   <li>"disconnected": null</li>
   <li>"error": error object</li>
   <li>"console":  { "time":Date object "data":string}</li>
   <li>"graph-data": { "time":Date object "graph":string "series":string "data":number}</li>
   <li>"graph-event": { "time":Date object "graph":string "series":string "data":string}</li>
  </ul>

 * @callback uBitEventCallback
 * @param {string} event ("connection failure", "connected", "disconnected", "error", "console", "graph-data", "graph-event" )
 * @param {USBDevice} device triggering the callback
 * @param {*} data (event-specific data object). See list above for variants
 * 
 */


/**
 * Allow users to select a device to connect to.
 * 
 * @param {uBitEventCallback} callback function for device events
 */
function uBitConnectDevice(callback) { 




    navigator.usb.requestDevice({filters: [{ vendorId: MICROBIT_VENDOR_ID, productId: MICROBIT_PRODUCT_ID }]})
        .then(  d => { if(!d.opened) uBitOpenDevice(d, callback)} )
        .catch( () => callback("connection failure", null, null))
}

/* 
class 255
subclass 42

v 2.21
configuration: USBConfiguration {configurationValue: 1, configurationName: null, interfaces: Array(6)}
configurations: [USBConfiguration]
deviceClass: 239
deviceProtocol: 1
deviceSubclass: 2
deviceVersionMajor: 16
deviceVersionMinor: 0
deviceVersionSubminor: 0
manufacturerName: "Arm"
opened: false
productId: 516
productName: "BBC micro:bit CMSIS-DAP"
serialNumber: "9905360200052833cb54a5be6ea92c5b000000006e052820"
usbVersionMajor: 2
usbVersionMinor: 1
usbVersionSubminor: 0
vendorId: 3368
[[Prototype]]: USBDevice


v1.5
configuration: USBConfiguration {configurationValue: 1, configurationName: null, interfaces: Array(5)}
configurations: [USBConfiguration]
deviceClass: 239
deviceProtocol:  1
deviceSubclass: 2
deviceVersionMajor: 16
deviceVersionMinor: 0
deviceVersionSubminor: 0
manufacturerName: "ARM"
opened: false
productId: 516
productName: "\"BBC micro:bit CMSIS-DAP\""
serialNumber: "9901000051864e45002210060000004e0000000097969901"
usbVersionMajor: 2
usbVersionMinor: 1
usbVersionSubminor: 0
vendorId: 3368

v2.00
configuration: USBConfiguration {configurationValue: 1, configurationName: null, interfaces: Array(6)}
configurations: [USBConfiguration]
deviceClass: 239
deviceProtocol: 1
deviceSubclass: 2
deviceVersionMajor: 16
deviceVersionMinor: 0
deviceVersionSubminor: 0
manufacturerName: "ARM"
opened: false
productId: 516
productName: "\"BBC micro:bit CMSIS-DAP\""
serialNumber: "9904360254174e45005f000200000030000000009796990b"
usbVersionMajor: 2
usbVersionMinor: 1
usbVersionSubminor: 0
vendorId: 3368
[[Prototype]]: USBDevice





Where 
device.configurations[0].interfaces.alternates[0].interfaceClass == 255
device.configurations[0].interfaces.alternates[0].interfaceSubclass == 42
device.configurations[0].interfaces.alternates[0].interfaceProtocol == 0

device.configurations[0].interfaces.alternates[0].endpoints.length == 0 
or 
a0.endpoints.length == 2 && a0.endpoints.every(e => e.packetSize == 64)
 * 

          .then(() => {
                // Find interface; Based on https://github.com/microsoft/pxt/blob/58f4c4ae689c5a62be285d211c0d20cc7efba1d9/pxtlib/webusb.ts#L424
                for(i of device.configurations[0].interfaces) {
                    console.dir(i)
                    a0 = i.alternates[0]

                    if(a0.interfaceClass == 255 && a0.interfaceSubclass==3 && a0.interfaceProtocol==0) 
                    {
                        console.log("Most match")
                        if( (a0.endpoints.length == 0) ||
                            (a0.endpoints.length == 2 && a0.endpoints.every(e => e.packetSize == 64))) {
                            console.log('Found interface')
                            console.log(i.interfaceNumber)
                            return device.claimInterface(i.interfaceNumber)
                        }
                    }
                }
                console.log("No Match")
                // No match
                return Promise.reject()



pxt-microbit:
https://github.com/microsoft/pxt-microbit/blob/347f1e11e66fb3001f644435b83592c76e133d6f/editor/prepend/dapjs.js
https://github.com/microsoft/pxt-microbit/blob/347f1e11e66fb3001f644435b83592c76e133d6f/editor/dapjs.d.ts
https://github.com/microsoft/pxt-microbit/blob/347f1e11e66fb3001f644435b83592c76e133d6f/editor/flash.ts
https://github.com/microsoft/pxt-microbit/blob/3b546c591eb41e895cbbaa3b955ef1f028b93a02/editor/extension.tsx



reconnectAsync() :  This is the magic on the MakeCode side
https://github.com/microsoft/pxt-microbit/blob/347f1e11e66fb3001f644435b83592c76e133d6f/editor/flash.ts#L284



const MICROBIT_VENDOR_ID = 
const MICROBIT_PRODUCT_ID = 

navigator.usb.requestDevice({filters: [{ vendorId: 0x0d28, productId: 0x0204 }]}).then( d=> k=d) 

*/



/*
Original order
          .then(() => device.selectConfiguration(1))
          .then(() => device.claimInterface(4))
          .then(controlTransferOutFN(Uint8Array.from([2, 0])))  // Connect in default mode: https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__Connect.html
          .then(controlTransferOutFN(Uint8Array.from([0x11, 0x80, 0x96, 0x98, 0]))) // Set Clock: 0x989680 = 10MHz : https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWJ__Clock.html
          .then(controlTransferOutFN(Uint8Array.from([0x13, 0]))) // SWD Configure (1 clock turn around; no wait/fault): https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWD__Configure.html
          // 0x82 = ID_DAP_UART_SetConfiguration : https://github.com/ARMmbed/DAPLink/blob/main/source/daplink/cmsis-dap/daplink_vendor_commands.h
          .then(controlTransferOutFN(Uint8Array.from([0x82, 0x00, 0xc2, 0x01, 0x00]))) // Vendor Specific command 2 (ID_DAP_Vendor2): https://github.com/ARMmbed/DAPLink/blob/0711f11391de54b13dc8a628c80617ca5d25f070/source/daplink/cmsis-dap/DAP_vendor.c ;  0x0001c200 = 115,200kBps
          .then(() => { callback("connected", device, null); return Promise.resolve()}) 
          .then(transferLoop)

 


dapjs serial:

          .then(controlTransferOutFN(Uint8Array.from([17, 128, 150, 152, 0])))  // DAP_SWJ_Sequence
          .then(controlTransferOutFN(Uint8Array.from([2, 0])))  // Connect in default mode: https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__Connect.html
          .then(controlTransferOutFN(Uint8Array.from([4, 0, 100, 0, 0, 0])))  // Transfer Configure: https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__TransferConfigure.html;  0 extra idle ; 100 retries after wait
          .then(controlTransferOutFN(Uint8Array.from([18,  56, 255, 255, 255, 255, 255, 255, 255]))) // SWD Configure (1 clock turn around; no wait/fault): https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWD__Configure.html
          .then(controlTransferOutFN(Uint8Array.from([18,  16, 158, 231]))) // SWD Configure (1 clock turn around; no wait/fault): https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWD__Configure.html
          .then(controlTransferOutFN(Uint8Array.from([18,  8, 0]))) // SWD Configure (1 clock turn around; no wait/fault): https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__SWD__Configure.html
          .then(controlTransferOutFN(Uint8Array.from([129, ]))) //Vendor 1 or 3
          .then(controlTransferOutFN(Uint8Array.from([0x3]))) // DAP Disconnect???





 */