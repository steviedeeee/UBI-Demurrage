import React, { useState, useEffect, useContext } from 'react'
import { View, Text, ScrollView } from 'react-native'
import { globalStyles } from '../styles/global'
import Auth from '@aws-amplify/auth'
import Card from '../shared/card'
import CustomButton from '../shared/buttons/button'
import ExportKeys from './auth/_keys'
import { resetClient } from '../../App'
import { useNotifications } from '../shared/notifications'

export default function Home () {
  const { maniClient } = global

  const notification = useNotifications()
  const [email, setEmail] = useState('')
  const [alias, setAlias] = useState('')

  useEffect(() => {
    loadEmailFromUser()
  }, [])

  async function loadEmailFromUser () {
    await Auth.currentSession()
      .then(data => {
        setEmail(data.idToken.payload['email'])
        setAlias(data.idToken.payload['custom:alias'])
      })
      .catch(err => console.log(err))
  }

  async function signOut (clearKeys = false) {
    const proceed = confirm(
      'Bent u zeker dat u wil afmelden? Denk eraan om uw sleutels te exporteren als u op een ander toestel wil aanmelden!'
    )
    if (!proceed) return
    try {
      if (clearKeys) await maniClient.cleanup()
      await resetClient()
      await Auth.signOut({ global: true })
    } catch (e) {
      console.error('signOut', e)
      notification.add({
        message: e && e.message,
        title: 'Afmelden mislukt',
        type: 'warning'
      })
    }
  }

  return (
    <ScrollView style={globalStyles.main}>
      <View style={{ marginBottom: 10 }}>
        <Card>
          <Text style={globalStyles.cardPropertyText}>Ingelogd als:</Text>
          <Text style={globalStyles.cardValueText}>{alias || '-'}</Text>
        </Card>
        <Card>
          <Text style={globalStyles.cardPropertyText}>E-mailadres:</Text>
          <Text style={globalStyles.cardValueText}>{email || '-'}</Text>
        </Card>
      </View>

      <ExportKeys />
      <CustomButton text='Afmelden' onPress={() => signOut()} />
      {/* <CustomButton
        text='Afmelden en sleutels wissen'
        onPress={() => signOut(true)}
      /> */}
    </ScrollView>
  )
}
