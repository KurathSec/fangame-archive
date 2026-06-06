var to;

function setRate(rate) {
  	if (rate==-1) $("#ratingSpan").html('None'); 
  	else          $("#ratingSpan").html((rate/10).toFixed(1) + ' ' + rateNames[Math.floor(rate/10)]); 
}

function setDiff(diff) {
  	if (diff==-1) $("#diffSpan").html('None'); 
	else          $("#diffSpan").html(diff + ' ' + diffNames[Math.floor(diff/10)]); 
}

$(document).ready(function(){
	$input = $("#admin-download-input");
	$button = $("#admin-change-download");
	$link = $("#game-link");
	$nolink = $("#no-link");
	$button.click(function(event) {
		$('.game_url_update_alert').hide();
		event.preventDefault();
		if (!$input.is(":visible")) {
			$link.hide();
			$nolink.hide();
			$input.show();
			$button.html('Update');
			$button.prop('disabled', false);
		} else {
			var req = {};
			req['id'] = getGameId();
			req['method'] = "game_update_url";
			req['url'] = $input.val();
		
			$button.prop('disabled', true);
			$.post( "/admin/admin_api.php", req).done(function( data ) {
				$button.prop('disabled', false);
				try {
					var rsp = $.parseJSON(data);
					console.log(rsp);
					if (rsp.success) {
						$input.hide();
						if (rsp.url == null) $nolink.show();
						else $link.show();
						$button.html('Change URL');
						$link.attr("href",rsp.url);
						$('.game_url_update_alert').html("Updated!").show().delay(3000).fadeOut();
					} else throw rsp.error;
				} catch (err) {
				 	$('.game_url_update_alert').html("Error: " + err).show().delay(3000).fadeOut();
				}
		  	});
		  	
		}
	});

  $cinput = $("#admin-creator-input");
	$cbutton = $("#admin-change-creator");
	$clabel = $("#creator-label");
	$cbutton.click(function(event) {
		$('.game_url_update_alert').hide();
		event.preventDefault();
		if (!$cinput.is(":visible")) {
			$clabel.hide();
			//$nolink.hide();
			$cinput.show();
			$cbutton.html('Update');
			$cbutton.prop('disabled', false);
		} else {
			var req = {};
			req['id'] = getGameId();
			req['method'] = "game_update_creator";
			req['value'] = $cinput.val();
		
			$cbutton.prop('disabled', true);
			$.post( "/admin/admin_api.php", req).done(function( data ) {
				$cbutton.prop('disabled', false);
				try {
					var rsp = $.parseJSON(data);
					console.log(rsp);
					if (rsp.success) {
						$cinput.hide();
						$clabel.show();
						$cbutton.html('Change Creator');
						$clabel.html('Creator: '+rsp.author);
						$('.game_creator_update_alert').html("Updated!").show().delay(3000).fadeOut();
					} else throw rsp.error;
				} catch (err) {
				 	$('.game_creator_update_alert').html("Error: " + err).show().delay(3000).fadeOut();
				}
		  	});
		  	
		}
	});

	$("#images").PikaChoose({carousel:true,carouselOptions:{wrap:'circular'}});
	
	setRate(getRate());
	setDiff(getDiff());
	
  	if (getGRate()==-1) $("#avgRatingLabel").html('None'); 
  	else                $("#avgRatingLabel").html(rateNames[Math.floor(getGRate()/10)]); 
  	if (getGDiff()==-1) $("#avgDiffLabel").html('None'); 
  	else                $("#avgDiffLabel").html(diffNames[Math.floor(getGDiff()/10)]); 

	$("#chk_favorite").change(function() {
		$('.favorite_alert').hide();
		var req = {};
		req['method'] = 'favorite';
		req['id'] = getGameId();
		req['opt'] = this.checked ? '1' : '0';
		$.post( "ratings_api.php", req).done(function( data ) {
			try {
				console.log(data);
				var rsp = $.parseJSON(data);
				if (rsp.success) {
					$('.favorite_alert').html("Updated!").show().delay(3000).fadeOut();
				} else {
					throw rsp.error;
				}
			} catch (err) {
				$('.favorite_alert').html("Error: " + err).show().delay(3000).fadeOut();
			}
		});  
    });
    
	$("#chk_clear").change(function() {
		$('.clear_alert').hide();
		var req = {};
		req['method'] = 'clear';
		req['id'] = getGameId();
		req['opt'] = this.checked ? '1' : '0';
		$.post( "ratings_api.php", req).done(function( data ) {
			try {
				console.log(data);
				var rsp = $.parseJSON(data);
				if (rsp.success) {
					$('.clear_alert').html("Updated!").show().delay(3000).fadeOut();
				} else {
					throw rsp.error;
				}
			} catch (err) {
				$('.clear_alert').html("Error: " + err).show().delay(3000).fadeOut();
			}
		});    
    });
    
	$("#chk_bookmark").change(function() {
		$('.bookmark_alert').hide();
		var req = {};
		req['method'] = 'bookmark';
		req['id'] = getGameId();
		req['opt'] = this.checked ? '1' : '0';
		$.post( "ratings_api.php", req).done(function( data ) {
			try {
				console.log(data);
				var rsp = $.parseJSON(data);
				if (rsp.success) {
					$('.bookmark_alert').html("Updated!").show().delay(3000).fadeOut();
				} else {
					throw rsp.error;
				}
			} catch (err) {
				$('.bookmark_alert').html("Error: " + err).show().delay(3000).fadeOut();
			}
		});    
    });
	
	$( "#rating" ).slider({
	  min: -1,
	  max: 100,
	  value: getRate(),
	  step: 1,
	  
	  change:function(event, ui) { setRate(ui.value); },
	  slide:function(event, ui) { setRate(ui.value); }
	});
	$( "#difficulty" ).slider({
	  min: -1,
	  max: 100,
	  value: getDiff(),
	  step: 1,
	  
	  change:function(event, ui) { setDiff(ui.value); },
	  slide:function(event, ui) { setDiff(ui.value); }
	});
	
	$("#update_button").click(function() {
		$('.ajax_alert').hide();
		
		var rat = $("#rating").slider( "value" );
		var dif = $("#difficulty").slider( "value" );
		
		var tags = $("#tags").val();
		
		var req = {};
		req['id'] = getGameId();
		req['rating'] = rat;
		req['difficulty'] = dif;
		req['comment'] = $("#mycomment").val();
		req['tags']=tags;
		if (req['comment'].length > 50000) req['comment'] = req['comment'].substring(1,50001);
		
		$.post( "ratings_api.php", req).done(function( data ) {
			try {
				var rsp = $.parseJSON(data);
				
				if (rsp.success) window.location.reload();
				else throw rsp.error;
			} catch (err) {
			 	$('.ajax_alert').html("Error: " + err).show().delay(3000).fadeOut();
			}
	  	});
	});
	
	$("#delete_button").click(function() {
		$('.ajax_alert').hide();
		
		var req = {};
		req['id'] = getGameId();
		req['method'] = 'delete_review';
		
		$.post( "ratings_api.php", req).done(function( data ) {
			try {
				var rsp = $.parseJSON(data);
				if (rsp.success) window.location.reload();
				else throw rsp.error;
			} catch (err) {
			 	$('.ajax_alert').html("Error: " + err).show().delay(3000).fadeOut();
			}
	  	});
	});
	
	$('#myreviewtoggle').click(function() {
    	$('#myreviewtoggle').slideUp( "slow", function() {});
		$( "#myreview" ).slideDown( "slow", function() {});
	});
	
	function getTagSuggestions(force) {
		//if (force || ((new Date().getTime()/1000 - 5)-lastUpdate >=2 )) {
			$('.tags_alert').hide();
			//lastUpdate=new Date().getTime()/1000;
			
			var req = {};
			req['tags']=$("#tags").val();
			req['method']='get_tags';
			
			$.post( "ratings_api.php", req).done(function( data ) {
				try {
					var rsp = $.parseJSON(data);
					if (rsp.success) {
						$('.tags_alert').html('<span>Tag suggestions:</span><br>');
						var impossible_found=false;
						for (var key in rsp.tag_map) {
							$('.tags_alert').append('<span>'+key+': </span> ');
							if ((""+key).toUpperCase() == (""+rsp.tag_map[key]).toUpperCase()) {
								$('.tags_alert').append('<span>✓</span> ');
									if (""+key === "Impossible") {
										impossible_found=true;
									}
							} else {
								for (var key2 in rsp.tag_map[key]) {
									$('.tags_alert').append('<span>'+rsp.tag_map[key][key2]+'</span> ');
									if (""+rsp.tag_map[key][key2] === "Impossible") {
										impossible_found=true;
									}
								}
							}
							$('.tags_alert').append('<br> ');
						}
						if (impossible_found) {
							$('.tags_alert').append('<a target="_blank" href="http://www.iwannacommunity.com/forum/index.php?topic=1386.msg12696#msg12696">Warning: Do not use the Impossible tag unless you are 100% sure the game is impossible.</a>');
						}
						$('.tags_alert').slideDown('slow');
					}
					//else throw rsp.error;
				} catch (err) {
				 	$('.tags_alert').html("Error: " + err).show().delay(3000).fadeOut();
				}
		  	});
		//}
	}
	
	$('#tags').keyup(function() { if (to) {clearTimeout(to);} to=setTimeout(function() {getTagSuggestions(false);}, 2000); });
	//$('#tags').change(function() { getTagSuggestions(true); });
}); //END DOCUMENT READY

var ias = $.ias({
  container:  '#reviews',
  item:       '.review',
  pagination: '#pagination',
  next:       '.next a'
});
// Add a loader image which is displayed during loading
ias.extension(new IASSpinnerExtension());
// Add a link after page 2 which has to be clicked to load the next page
ias.extension(new IASTriggerExtension({offset: 3}));
// Add a text when there are no more pages left to load
ias.extension(new IASNoneLeftExtension({text: "You reached the end"}));

ias.on('rendered', function(items) {
	review_setup($(items));
});