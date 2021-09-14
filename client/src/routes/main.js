import React, { useState, useEffect } from 'react'
import { createMaterialBottomTabNavigator } from '@react-navigation/material-bottom-tabs'
import { NavigationContainer } from '@react-navigation/native'
import { View } from 'react-native'
import {
  MaterialIcons,
  MaterialCommunityIcons,
  Entypo
} from '@expo/vector-icons'

import AccountStack from '../routes/stacks/accountStack'
import HomeStack from './stacks/homeStack'
import QrStack from '../routes/stacks/qrStack'
import TransactionHistoryStack from '../routes/stacks/transactionHistoryStack'
import ContributionHistoryStack from '../routes/stacks/contributionHistoryStack'
import StandingOrderStack from '../routes/stacks/standingOrderStack'
// import FreeBufferStack from '../routes/stacks/freeBufferStack'
// import ContactListStack from '../routes/stacks/contactListStack'
import { globalStyles } from '../styles/global'
import { colors } from '../helpers/helper'

const iconProps = { size: 24 }

const screens = ({ Nav }) => ({
  // Overview: (
  //   <Nav.Screen
  //     key='Overview'
  //     name='Overview'
  //     tabBarLabel='Overview'
  //     component={HomeStack}
  //     tabBarIcon={({ focused, color = 'white' }) => (
  //       <MaterialIcons name='home' color={color} {...iconProps} />
  //     )}
  //   />
  // ),
  LoREco: (
    <Nav.Screen
      key='LoREco'
      name='LoREco'
      component={QrStack}
      options={{
        drawerIcon: props => (
          <MaterialIcons name='home' color={props.color} {...iconProps} />
        ),
        tabBarIcon: ({ focused, color = 'white' }) => (
          <MaterialIcons name='home' color={color} {...iconProps} />
        )
      }}
    />
  ),
  Geschiedenis: (
    <Nav.Screen
      key='Geschiedenis'
      name='Geschiedenis'
      component={TransactionHistoryStack}
      options={{
        drawerIcon: props => (
          <MaterialIcons name='history' color={props.color} {...iconProps} />
        ),
        tabBarIcon: ({ focused, color = 'white' }) => (
          <MaterialIcons name='history' color={color} {...iconProps} />
        )
      }}
    />
  ),
  'Bijdrage Geschiedenis': (
    <Nav.Screen
      key='Bijdrage Geschiedenis'
      name='Bijdrage Geschiedenis'
      component={ContributionHistoryStack}
      options={{
        drawerIcon: props => (
          <MaterialIcons
            name='swap-vertical-circle'
            color={props.color}
            {...iconProps}
          />
        ),
        tabBarIcon: ({ focused, color = 'white' }) => (
          <MaterialIcons
            name='swap-vertical-circle'
            color={color}
            {...iconProps}
          />
        )
      }}
    />
  ),
  // Betalingsopdrachten: (
  //   <Nav.Screen
  //     key='Betalingsopdrachten'
  //     name='Betalingsopdrachten'
  //     component={StandingOrderStack}
  //     options={{
  //       drawerIcon: props => (
  //         <MaterialIcons name='loop' color={props.color} {...iconProps} />
  //       ),
  //       tabBarIcon: ({ focused, color = 'white' }) => (
  //         <MaterialIcons name='loop' color={color} {...iconProps} />
  //       )
  //     }}
  //   />
  // ),
  // 'Beheer Vrije Buffer': (
  //   <Nav.Screen
  //     key='Beheer Vrije Buffer'
  //     name='Beheer Vrije Buffer'
  //     component={FreeBufferStack}
  //     options={{
  //       drawerIcon: props => (
  //         <Entypo name='bar-graph' color={props.color} {...iconProps} />
  //       ),
  // tabBarIcon={({focused, color = 'white'}) => <MaterialIcons name='home' color={color} {...iconProps} />}
  //     }}
  //   />
  // ),
  // Contacten: (
  //   <Nav.Screen
  //     key='Contacten'
  //     name='Contacten'
  //     component={ContactListStack}
  //     options={{
  //       drawerIcon: props => (
  //         <MaterialCommunityIcons
  //           name='contacts'
  //           color={props.color}
  //           {...iconProps}
  //         />
  //       ),
  // tabBarIcon={({focused, color = 'white'}) => <MaterialIcons name='contacts' color={color} {...iconProps} />}
  //     }}
  //   />
  // ),
  Account: (
    <Nav.Screen
      key='Account'
      name='Account'
      component={AccountStack}
      options={{
        tabBarIcon: ({ focused, color = 'white' }) => (
          <MaterialCommunityIcons
            name='account-circle'
            color={color}
            {...iconProps}
          />
        )
      }}
    />
  )
})

export default function drawerNavigator (props) {
  const [hasPending, setPending] = useState(null)
  const [isReady, setReady] = useState(null)
  const ManiClient = global.maniClient
  const Nav = createMaterialBottomTabNavigator()
  const navScreens = screens({ Nav })

  useEffect(() => {
    if (!isReady) {
      getPending().then(p => {
        setPending(p)
        setReady(true)
      })
    }
  }, [isReady])

  const getPending = async () => {
    const data = await ManiClient.transactions.pending()
    return data && data.length
  }

  console.log(hasPending)

  if (props.authState === 'signedIn') {
    return (
      <View style={globalStyles.container}>
        <NavigationContainer>
          <Nav.Navigator barStyle={{ backgroundColor: colors.DarkerBlue }}>
            {hasPending
              ? ['Betalingsopdrachten'].map(screen => navScreens[screen])
              : Object.keys(navScreens).map(screen => navScreens[screen])}
          </Nav.Navigator>
        </NavigationContainer>
      </View>
    )
  } else {
    return null
  }
}
