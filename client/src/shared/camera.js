import log from 'loglevel'
import React, { useState, useEffect } from 'react'

import { View, Text, StyleSheet, Platform } from 'react-native'
import QrScanner from 'react-qr-scanner'
import Button from '../shared/buttons/largeRoundTextButton'
import { globalStyles } from '../styles/global'

export default function Cam (props) {
  const [hasPermission, setHasPermission] = useState(null)
  const [scanned, setScanned] = useState(false)

  const handleBarCodeScanned = barcode => {
    // barcode in the format: "loreco://scan/f8aca881b6f87f9aa42708943ce067ef8334e9e8/16000"
    // barcode in the general format: "loreco://<action>/<source:fingerprint>/<amount>?"
    log.debug('QrScanner/onScan:', barcode)
    if (barcode) {
      props.onBarCodeScanned(barcode)
      setScanned(true)
    }
  }

  const handleBarCodeError = err => {
    if (err === 'Permission denied') setHasPermission(false) // Check for correct err msg (NotAllowedError)
    console.error('QrScanner ERROR:', err)
  }

  if (hasPermission === false) return <Text>No access to camera</Text>

  return (
    <View style={globalStyles.screen}>
      <View style={globalStyles.camPlace}>
        <QrScanner
          onLoad={props.onInit}
          constraints={{ video: { facingMode: { exact: `environment` } } }}
          delay={100}
          onError={handleBarCodeError}
          onScan={handleBarCodeScanned}
        >
          <Text>Requesting for camera permission</Text>
        </QrScanner>
      </View>

      <View style={globalStyles.qrTextContainer}>
        <Text style={globalStyles.qrText}>{props.text}</Text>
      </View>
    </View>
  )
}
